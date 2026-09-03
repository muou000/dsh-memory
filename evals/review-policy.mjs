import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MemoryStore, resolveConfig } from '../lib/index.js'

const startedAt = new Date().toISOString()
const sourceRevision = process.env.DSH_MEMORY_SOURCE_REVISION ?? gitRevision()
const sourceDirty = process.env.DSH_MEMORY_SOURCE_DIRTY === undefined
  ? gitDirty()
  : process.env.DSH_MEMORY_SOURCE_DIRTY === 'true'
const arms = ['off', 'shadow', 'enforce']
const caseDefinitions = [
  { id: 'grounded-publish', expected: { off: 'candidate', shadow: 'candidate', enforce: 'published' } },
  { id: 'low-confidence-defer', expected: { off: 'candidate', shadow: 'candidate', enforce: 'candidate' } },
  { id: 'contradictory-reject-defer', expected: { off: 'candidate', shadow: 'candidate', enforce: 'candidate' } },
  { id: 'duplicate-reject', expected: { off: 'candidate', shadow: 'candidate', enforce: 'rejected' } },
  { id: 'stale-update-defer', expected: { off: 'candidate', shadow: 'candidate', enforce: 'candidate' } },
]
const results = []
for (const definition of caseDefinitions) {
  const observed = {}
  for (const arm of arms) observed[arm] = await runCase(definition.id, arm)
  results.push({ id: definition.id, expected: definition.expected, observed })
}

const pairedChecks = results.flatMap(result => arms.map(arm => ({
  caseId: result.id,
  arm,
  expected: result.expected[arm],
  actual: result.observed[arm].status,
  pass: result.expected[arm] === result.observed[arm].status
    && (arm === 'off' ? result.observed[arm].reviewAudits === 0 : result.observed[arm].reviewAudits === 2),
})))
const falsePublishes = results.filter(result => result.expected.enforce !== 'published'
  && result.observed.enforce.status === 'published').length
const falseRejects = results.filter(result => result.expected.enforce !== 'rejected'
  && result.observed.enforce.status === 'rejected').length
const metrics = {
  cases: results.length,
  pairedChecks: pairedChecks.length,
  pairedChecksPassed: pairedChecks.filter(check => check.pass).length,
  falsePublishes,
  falseRejects,
  enforcePublished: results.filter(result => result.observed.enforce.status === 'published').length,
  enforceRejected: results.filter(result => result.observed.enforce.status === 'rejected').length,
  enforceDeferred: results.filter(result => result.observed.enforce.status === 'candidate').length,
}
const report = {
  format: 'dsh-memory-review-policy-evaluation',
  version: 1,
  qualification: 'deterministic-development',
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version,
  platform,
  arch,
  sourceRevision,
  sourceDirty,
  policy: {
    modes: arms,
    reviewMinConfidence: 0.9,
    nearDuplicateThreshold: 0.1,
    reviewerRoute: { provider: 'review', model: 'review-model' },
    extractionRoute: { provider: 'extract', model: 'extract-model' },
  },
  policySha256: sha256(JSON.stringify({ cases: caseDefinitions, arms })),
  results,
  metrics,
  thresholds: {
    pairedChecksPassed: pairedChecks.length,
    falsePublishes: 0,
    falseRejects: 0,
  },
  pass: metrics.pairedChecksPassed === pairedChecks.length
    && metrics.falsePublishes === 0
    && metrics.falseRejects === 0,
  limitations: [
    'This keyless evaluation exercises deterministic store policy only.',
    'It does not establish reviewer semantic quality, model independence, latency, cost, or production safety.',
    'Production enforce mode still requires held-out paired model and shadow/canary evidence.',
  ],
}
const output = process.env.DSH_MEMORY_REVIEW_POLICY_OUTPUT
  ?? join('evals', 'reports', 'review-policy-latest.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1

async function runCase(caseId, mode) {
  const root = await mkdtemp(join(tmpdir(), `dsh-memory-review-${caseId}-${mode}-`))
  const workspace = join(root, 'workspace')
  const config = resolveConfig({
    dshHome: root,
    markdownProjection: false,
    autoConsolidate: true,
    aiReviewMode: mode,
    consolidationProvider: 'extract',
    consolidationModel: 'extract-model',
    reviewProvider: 'review',
    reviewModel: 'review-model',
    reviewMinConfidence: 0.9,
    nearDuplicateThreshold: 0.1,
  }, {})
  const store = new MemoryStore(config)
  try {
    const fixture = createFixture(store, workspace, caseId)
    if (mode === 'off') return summarize(store, fixture.candidate.id)
    const requestId = `${fixture.requestId}:ai-review:v1`
    const reference = {
      candidateId: fixture.candidate.id,
      candidateHash: fixture.candidate.contentHash,
      candidateRequestId: fixture.candidate.requestId,
      candidateActorId: fixture.candidate.actor.id,
    }
    store.recordAiReviewRequest({
      requestId,
      promptVersion: 1,
      sessionId: fixture.sessionId,
      workspace,
      turn: 1,
      endSeq: 5,
      sourceMessageSeqs: [2, 3],
      sourceHash: fixture.sourceHash,
      candidates: [reference],
      provider: 'review',
      model: 'review-model',
      systemHash: sha256('frozen-review-system-v1'),
      inputHash: sha256(`frozen-review-input:${caseId}`),
      maxInputChars: 64_000,
      maxTokens: 512,
      mode,
      minConfidence: 0.9,
      now: 10_000,
    })
    const decision = decisionFor(caseId)
    store.applyAiReviewResult({
      requestId,
      workspace,
      evidenceLocator: fixture.evidenceLocator,
      evidenceContentHash: fixture.sourceHash,
      reviewerId: `ai-reviewer:${sha256('review\u0000review-model').slice(0, 24)}`,
      mode,
      minConfidence: 0.9,
      outputHash: sha256(JSON.stringify(decision)),
      decisions: [{ ...reference, ...decision }],
      now: 11_000,
    })
    return summarize(store, fixture.candidate.id)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

function createFixture(store, workspace, caseId) {
  const sessionId = `review-eval-${caseId}`
  const requestId = `automatic:${sessionId}:created:1000:turn:1:proposal:0`
  const sourceHash = sha256(`frozen-source:${caseId}`)
  const evidenceLocator = `session:${sessionId};turn:1;through-seq:5`
  let target
  if (caseId === 'duplicate-reject' || caseId === 'stale-update-defer') {
    target = publish(store, workspace, `${caseId} base`, 1_000)
  }
  const operation = caseId === 'stale-update-defer' ? 'update' : 'create'
  const candidate = store.propose({
    operation,
    ...(operation === 'update' ? { targetMemoryId: target.memoryId, expectedRevision: 1 } : {}),
    content: content(workspace, caseId, evidenceLocator, sourceHash, operation === 'update' ? target.owner : undefined),
    actor: { kind: 'agent', id: `memory-consolidator:${sessionId}` },
    requestId,
    now: 5_000,
  })
  if (caseId === 'stale-update-defer') {
    const newer = store.propose({
      operation: 'update',
      targetMemoryId: target.memoryId,
      expectedRevision: 1,
      content: content(workspace, `${caseId} newer`, 'test:stale-update', sha256('newer-source'), target.owner),
      actor: { kind: 'migration', id: 'review-eval' },
      requestId: `${requestId}:newer`,
      now: 6_000,
    })
    store.review(newer.id, {
      action: 'publish',
      actor: { kind: 'human', id: 'review-eval-human' },
      reason: 'Advance target revision for stale update evaluation.',
      now: 7_000,
    })
  }
  return { candidate, evidenceLocator, requestId: requestId.replace(/:proposal:0$/, ''), sessionId, sourceHash }
}

function publish(store, workspace, subject, now) {
  const candidate = store.propose({
    content: {
      kind: 'semantic',
      scope: { type: 'workspace', key: workspace },
      subject,
      applicability: 'When the automatic review policy evaluates workspace knowledge.',
      action: 'Use the durable automatic review policy for this workspace rule.',
      rationale: 'A published fixture supplies deterministic target or duplicate state.',
      confidence: 0.95,
      sensitivity: 'internal',
      owner: 'review-eval',
      evidence: [{ kind: 'test', locator: `evals/review-policy/${subject}` }],
    },
    actor: { kind: 'migration', id: 'review-eval' },
    now,
  })
  return store.review(candidate.id, {
    action: 'publish',
    actor: { kind: 'human', id: 'review-eval-human' },
    reason: 'Publish deterministic review-policy fixture.',
    now: now + 1,
  }).publishedMemoryId === undefined
    ? (() => { throw new Error(`failed to publish fixture ${subject}`) })()
    : store.listRecords().find(record => record.memoryId === candidate.publishedMemoryId)
      ?? store.listRecords().at(-1)
}

function content(workspace, caseId, evidenceLocator, sourceHash, owner = `review-eval-${caseId}`) {
  const duplicate = caseId === 'duplicate-reject'
  return {
    kind: 'semantic',
    scope: { type: 'workspace', key: workspace },
    subject: duplicate ? 'duplicate-reject base related rule' : `${caseId} candidate`,
    applicability: 'When the automatic review policy evaluates workspace knowledge.',
    action: duplicate
      ? 'Use the durable automatic review policy for this workspace rule with a small wording change.'
      : `Apply the frozen ${caseId} policy decision.`,
    rationale: `Deterministic paired evidence for ${caseId}.`,
    confidence: 0.95,
    sensitivity: 'internal',
    owner,
    evidence: [{
      kind: 'session-event',
      locator: evidenceLocator,
      observedAt: 4_000,
      contentHash: sourceHash,
    }],
  }
}

function decisionFor(caseId) {
  const checks = {
    grounded: true,
    durable: true,
    scopeCorrect: true,
    nonSensitive: true,
    useful: true,
    nonDuplicate: true,
    nonConflicting: true,
  }
  if (caseId === 'low-confidence-defer') {
    return { verdict: 'publish', reason: 'Reviewer confidence is intentionally below the policy threshold.', confidence: 0.5, checks }
  }
  if (caseId === 'contradictory-reject-defer') {
    return { verdict: 'reject', reason: 'Contradictory reject has no failed check and must defer.', confidence: 0.99, checks }
  }
  if (caseId === 'duplicate-reject') {
    return {
      verdict: 'reject',
      reason: 'The deterministic store exposes a same-scope near-duplicate.',
      confidence: 0.99,
      checks: { ...checks, nonDuplicate: false },
    }
  }
  return { verdict: 'publish', reason: 'The frozen candidate passes the reviewer rubric.', confidence: 0.99, checks }
}

function summarize(store, candidateId) {
  const candidate = store.getCandidate(candidateId)
  if (candidate === undefined) throw new Error(`missing candidate ${candidateId}`)
  const reviewAudits = store.listAudit().filter(row => row.action === 'ai-review.request'
    || row.action === 'ai-review.complete').length
  return { status: candidate.status, reviewAudits }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function gitDirty() {
  try {
    return execFileSync('git', [
      'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)evals/reports/**',
    ], { encoding: 'utf8' }).trim().length > 0
  } catch {
    return true
  }
}
