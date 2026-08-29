import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { resolveConfig, MemoryStore } from '../lib/index.js'

const startedAt = new Date().toISOString()
const root = await mkdtemp(join(tmpdir(), 'dsh-memory-keyless-'))
const workspace = join(root, 'workspace')
const foreignWorkspace = join(root, 'foreign')
const config = resolveConfig({ dshHome: root, markdownProjection: false, retrievalCandidateLimit: 24 }, {})
const store = new MemoryStore(config)

function publish(subject, action, scope = workspace, now = 1_000) {
  const candidate = store.propose({
    content: {
      kind: 'semantic',
      scope: { type: 'workspace', key: scope },
      subject,
      applicability: `When evaluating ${subject}.`,
      action,
      rationale: `Held-out fixture evidence for ${subject}.`,
      confidence: 0.9,
      sensitivity: 'internal',
      owner: 'keyless-eval',
      evidence: [{ kind: 'test', locator: `evals/keyless/${subject.replaceAll(' ', '-')}` }],
    },
    actor: { kind: 'migration', id: 'keyless-eval' },
    now,
  })
  const published = store.review(candidate.id, {
    action: 'publish',
    actor: { kind: 'human', id: 'keyless-eval-reviewer' },
    reason: 'Frozen keyless evaluation fixture was reviewed.',
    now: now + 1,
  })
  if (published.publishedMemoryId === undefined) throw new Error(`fixture ${subject} was not published`)
  return published.publishedMemoryId
}

const expected = new Map()
for (const [subject, action] of [
  ['SQLite writer lock', 'Acquire one writer lock before opening the canonical store.'],
  ['Session scope filter', 'Filter by the current session before ranking.'],
  ['Projection rebuild', 'Rebuild Markdown from SQLite after a derived view failure.'],
  ['Secret rejection', 'Reject secret-like candidate content before persistence.'],
  ['Conflict review', 'Keep conflicting claims unavailable until a reviewer decides.'],
  ['Working memory TTL', 'Expire working memory at its configured session boundary.'],
]) {
  expected.set(subject, publish(subject, action))
}
for (const [subject, action] of [
  ['SQLite migration note', 'Document schema migration steps.'],
  ['Session title hint', 'Prefer a short title for the session.'],
  ['Projection color', 'Use a neutral color for generated pages.'],
  ['Secret scanner benchmark', 'Measure scanner throughput.'],
  ['Conflict taxonomy', 'Label the conflict type.'],
  ['Working memory example', 'Use a short-lived fixture.'],
]) publish(subject, action)
publish('Foreign workspace private rule', 'Never expose this to another workspace.', foreignWorkspace)

const access = { workspace, includeGlobal: false, maxSensitivity: 'internal' }
const cases = [
  ['writer lock', 'SQLite writer lock'],
  ['session scope', 'Session scope filter'],
  ['rebuild Markdown', 'Projection rebuild'],
  ['secret-like', 'Secret rejection'],
  ['conflicting claims', 'Conflict review'],
  ['working memory expire', 'Working memory TTL'],
]
let recall = 0
let precision = 0
let reciprocalRank = 0
for (const [query, subject] of cases) {
  const result = store.search(query, access, { limit: 6, now: 10_000 })
  const expectedId = expected.get(subject)
  const ids = result.hits.map(hit => hit.record.memoryId)
  const rank = ids.indexOf(expectedId)
  recall += rank >= 0 ? 1 : 0
  precision += rank >= 0 ? 1 / Math.max(1, ids.length) : 0
  reciprocalRank += rank >= 0 ? 1 / (rank + 1) : 0
}
const isolation = store.search('private rule', access, { limit: 6, now: 10_000 })
const metrics = {
  cases: cases.length,
  recallAt6: recall / cases.length,
  precisionAt6: precision / cases.length,
  mrr: reciprocalRank / cases.length,
  crossWorkspaceHits: isolation.hits.length,
}

const report = {
  format: 'dsh-memory-keyless-evaluation',
  version: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version,
  metrics,
  thresholds: { recallAt6: 0.85, precisionAt6: 0.70, mrr: 0.80, crossWorkspaceHits: 0 },
  pass: metrics.recallAt6 >= 0.85
    && metrics.precisionAt6 >= 0.70
    && metrics.mrr >= 0.80
    && metrics.crossWorkspaceHits === 0,
}
const output = process.env.DSH_MEMORY_EVAL_OUTPUT ?? join('evals', 'reports', 'keyless-latest.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
store.close()
await rm(root, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1
