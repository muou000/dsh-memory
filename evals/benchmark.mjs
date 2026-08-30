import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { arch, platform, totalmem } from 'node:os'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { resolveConfig, MarkdownProjection, MemoryStore, renderMemoryContext } from '../lib/index.js'

const count = Number(process.env.DSH_MEMORY_BENCHMARK_COUNT ?? 10_000)
if (!Number.isSafeInteger(count) || count < 10_000) throw new Error('benchmark count must be at least 10000')
const root = await mkdtemp(join(tmpdir(), 'dsh-memory-benchmark-'))
const workspace = join(root, 'workspace')
// The reference fixture deliberately contains unique synthetic subjects. Turn
// off near-duplicate hints so preparation measures the retrieval/rebuild path,
// rather than issuing an O(n) lexical-similarity scan for every inserted row.
const config = resolveConfig({
  dshHome: root,
  markdownProjection: true,
  retrievalCandidateLimit: 24,
  maxNearDuplicateSuggestions: 0,
}, {})
const sourceRevision = process.env.DSH_MEMORY_SOURCE_REVISION ?? gitRevision()
const sourceDirty = gitDirty()
const benchmarkConfig = {
  records: count,
  retrievalCandidateLimit: config.retrievalCandidateLimit,
  maxInjectedItems: config.maxInjectedItems,
  injectionTokenBudget: config.injectionTokenBudget,
  maxRenderedItemChars: config.maxRenderedItemChars,
  maxNearDuplicateSuggestions: config.maxNearDuplicateSuggestions,
}
const store = new MemoryStore(config)
const actor = { kind: 'migration', id: 'benchmark' }
const reviewer = { kind: 'human', id: 'benchmark-reviewer' }
let mutationTarget
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
  const reviewed = store.review(candidate.id, {
    action: 'publish', actor: reviewer,
    reason: 'Synthetic benchmark fixture was reviewed.', now: index + 2,
  })
  if (index === count - 1) mutationTarget = reviewed.publishedMemoryId
}
if (mutationTarget === undefined) throw new Error('benchmark failed to retain its mutation target')
const seedMs = performance.now() - began
const indexStarted = performance.now()
store.rebuildFts()
const indexRebuildMs = performance.now() - indexStarted
const projection = new MarkdownProjection(config)
const projectionNow = count + 20
const projectionStarted = performance.now()
const initialPublication = projection.rebuild(store, projectionNow)
const projectionInitialRebuildMs = performance.now() - projectionStarted
const warmProjectionStarted = performance.now()
const warmPublication = projection.rebuild(store, projectionNow)
const projectionWarmRebuildMs = performance.now() - warmProjectionStarted
store.feedback({
  id: 'benchmark-incremental-feedback',
  memoryId: mutationTarget,
  revision: 1,
  kind: 'helpful',
  actor: reviewer,
  now: count + 10,
})
const incrementalProjectionStarted = performance.now()
const incrementalPublication = projection.refresh(store, [mutationTarget], projectionNow)
const projectionIncrementalUpdateMs = performance.now() - incrementalProjectionStarted
const projectionVerification = projection.verify()
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
  format: 'dsh-memory-benchmark', version: 2, records: count, node: process.version,
  platform, arch, sourceRevision,
  sourceDirty,
  config: benchmarkConfig,
  configSha256: createHash('sha256').update(JSON.stringify(benchmarkConfig)).digest('hex'),
  totalMemoryBytes: totalmem(),
  seedMs: Number(seedMs.toFixed(3)), warmRuns: timings.length,
  indexRebuildMs: Number(indexRebuildMs.toFixed(3)),
  projectionRebuildMs: Number(projectionInitialRebuildMs.toFixed(3)),
  projectionInitialRebuildMs: Number(projectionInitialRebuildMs.toFixed(3)),
  projectionWarmRebuildMs: Number(projectionWarmRebuildMs.toFixed(3)),
  projectionIncrementalUpdateMs: Number(projectionIncrementalUpdateMs.toFixed(3)),
  projectionPublications: { initial: initialPublication, warm: warmPublication, incremental: incrementalPublication },
  projectionFiles: projectionVerification.fileCount,
  projectionValid: projectionVerification.valid,
  p50Ms: Number(percentile(0.5).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)),
  renderedTokens: last?.estimatedTokens ?? 0,
  seedNote: `${count.toLocaleString('en-US')} records were admitted through the real proposal/publication state machine with near-duplicate hints disabled for unique synthetic data; this is fixture preparation cost, not retrieval latency.`,
  thresholdP95Ms: 100,
  thresholdProjectionWarmMs: 15_000,
  thresholdProjectionIncrementalMs: 5_000,
  pass: percentile(0.95) <= 100
    && projectionVerification.valid
    && projectionVerification.fileCount === count + 4
    && projectionWarmRebuildMs <= 15_000
    && projectionIncrementalUpdateMs <= 5_000
    && warmPublication.mode === 'full'
    && warmPublication.writtenFiles === 0
    && incrementalPublication.mode === 'incremental'
    && incrementalPublication.writtenFiles === 1
    && incrementalPublication.totalFiles === count + 4,
}
report.releaseEligible = report.pass && !sourceDirty
const output = process.env.DSH_MEMORY_BENCHMARK_OUTPUT ?? join('evals', 'reports', 'benchmark-latest.json')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
store.close()
await rm(root, { recursive: true, force: true })
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1

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
