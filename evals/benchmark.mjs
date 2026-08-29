import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { resolveConfig, MemoryStore, renderMemoryContext } from '../lib/index.js'

const count = Number(process.env.DSH_MEMORY_BENCHMARK_COUNT ?? 10_000)
if (!Number.isSafeInteger(count) || count < 10_000) throw new Error('benchmark count must be at least 10000')
const root = await mkdtemp(join(tmpdir(), 'dsh-memory-benchmark-'))
const workspace = join(root, 'workspace')
const config = resolveConfig({ dshHome: root, markdownProjection: false, retrievalCandidateLimit: 24 }, {})
const store = new MemoryStore(config)
const actor = { kind: 'migration', id: 'benchmark' }
const reviewer = { kind: 'human', id: 'benchmark-reviewer' }
const began = performance.now()
for (let index = 0; index < count; index += 1) {
  const candidate = store.propose({
    content: {
      kind: 'semantic',
      scope: { type: 'workspace', key: workspace },
      subject: `Benchmark rule ${index}`,
      applicability: `When benchmark query ${index} is evaluated.`,
      action: `Use deterministic benchmark action ${index}.`,
      rationale: 'Synthetic keyless benchmark evidence.',
      confidence: 0.9,
      sensitivity: 'internal',
      owner: 'benchmark',
      evidence: [{ kind: 'test', locator: `benchmark/${index}` }],
    },
    actor,
    now: index + 1,
  })
  store.review(candidate.id, {
    action: 'publish', actor: reviewer,
    reason: 'Synthetic benchmark fixture was reviewed.', now: index + 2,
  })
}
const seedMs = performance.now() - began
const access = { workspace, includeGlobal: false, maxSensitivity: 'internal' }
const timings = []
let last
for (let run = 0; run < 25; run += 1) {
  const start = performance.now()
  const result = store.search('benchmark deterministic action 9999', access, { limit: 6, now: count + 10 })
  last = renderMemoryContext(result.hits, config)
  timings.push(performance.now() - start)
}
timings.sort((left, right) => left - right)
const percentile = value => timings[Math.min(timings.length - 1, Math.floor(timings.length * value))]
const report = {
  format: 'dsh-memory-benchmark', version: 1, records: count, node: process.version,
  seedMs: Number(seedMs.toFixed(3)), warmRuns: timings.length,
  p50Ms: Number(percentile(0.5).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)),
  renderedTokens: last?.estimatedTokens ?? 0,
  thresholdP95Ms: 100,
  pass: percentile(0.95) <= 100,
}
const output = process.env.DSH_MEMORY_BENCHMARK_OUTPUT ?? join('evals', 'reports', 'benchmark-latest.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
store.close()
await rm(root, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1
