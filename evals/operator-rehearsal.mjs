import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { MemoryStore, resolveConfig } from '../lib/index.js'

const output = process.env.DSH_MEMORY_OPERATOR_EVAL_OUTPUT ?? 'evals/reports/operator-rehearsal-latest.json'
const root = await mkdtemp(join(tmpdir(), 'dsh-memory-operator-'))
const startedAt = new Date().toISOString()
const started = performance.now()
const checks = {}
let report
const sourceRevision = process.env.DSH_MEMORY_SOURCE_REVISION ?? gitRevision()
const sourceDirty = gitDirty()

try {
  const sourceHome = join(root, 'source-home')
  const sourceProjection = join(root, 'source-knowledge')
  const sourceConfig = resolveConfig({
    dshHome: sourceHome,
    projectionPath: sourceProjection,
    markdownProjection: false,
  }, {})
  const evaluationConfig = {
    markdownProjection: sourceConfig.markdownProjection,
    readOnly: sourceConfig.readOnly,
    integrityCheckOnStart: sourceConfig.integrityCheckOnStart,
    reviewedCandidateRetentionDays: sourceConfig.reviewedCandidateRetentionDays,
    queryTextRetentionDays: sourceConfig.queryTextRetentionDays,
    retrievalRetentionDays: sourceConfig.retrievalRetentionDays,
    feedbackRetentionDays: sourceConfig.feedbackRetentionDays,
    auditRetentionDays: sourceConfig.auditRetentionDays,
  }
  const seed = new MemoryStore(sourceConfig)
  const candidate = seed.propose({
    content: {
      kind: 'procedural',
      scope: { type: 'workspace', key: join(root, 'workspace') },
      subject: 'Operator rehearsal backup rule',
      applicability: 'When rehearsing a dsh-memory release.',
      action: 'Validate a new restore path before changing the deployment pointer.',
      rationale: 'A rollback target must be independently readable before rollout.',
      confidence: 0.95,
      sensitivity: 'internal',
      owner: 'release-operator',
      evidence: [{ kind: 'test', locator: 'evals/operator-rehearsal.mjs' }],
    },
    actor: { kind: 'migration', id: 'operator-rehearsal' },
    now: 1_000,
  })
  seed.close()

  const location = ['--store', sourceConfig.storagePath, '--projection', sourceProjection]
  checks.candidateInspection = parse(run(['candidates', ...location])).some(item => item.id === candidate.id)
  checks.humanPublication = parse(run([
    'publish', candidate.id, ...location,
    '--actor', 'release-operator', '--reason', 'Frozen rehearsal evidence reviewed.',
  ])).status === 'published'
  const sourceStatus = parse(run(['status', '--store', sourceConfig.storagePath]))
  checks.healthReadable = sourceStatus.health.state === 'degraded-read-only'
    && sourceStatus.health.integrity === 'ok'
    && sourceStatus.stats.recordsByStatus.active === 1
  checks.projectionIntegrity = parse(run(['projection-status', ...location])).valid === true

  const backupPath = join(root, 'backup', 'memory.sqlite')
  const backup = parse(run(['backup', backupPath, '--store', sourceConfig.storagePath]))
  checks.sqliteBackup = backup.pages > 0

  const portable = run(['export', '--store', sourceConfig.storagePath])
  const portablePath = join(root, 'portable.json')
  await writeFile(portablePath, portable)
  checks.portableExport = parse(portable).records.length === 1

  const importHome = join(root, 'import-home')
  const importProjection = join(root, 'import-knowledge')
  const importConfig = resolveConfig({ dshHome: importHome }, {})
  const imported = parse(run([
    'import', portablePath,
    '--store', importConfig.storagePath,
    '--projection', importProjection,
  ]))
  checks.portableImport = imported.imported === true && imported.stats.recordsByStatus.active === 1
  checks.importProjectionIntegrity = parse(run([
    'projection-status', '--store', importConfig.storagePath, '--projection', importProjection,
  ])).valid === true

  const restoredPath = join(root, 'restored', 'memory.sqlite')
  checks.sqliteRestore = parse(run(['restore', backupPath, restoredPath])).pages > 0
  const restoredStatus = parse(run(['status', '--store', restoredPath]))
  checks.rollbackTargetReadable = restoredStatus.health.state === 'degraded-read-only'
    && restoredStatus.health.integrity === 'ok'
    && restoredStatus.stats.recordsByStatus.active === 1

  const pass = Object.values(checks).every(Boolean)
  report = {
    format: 'dsh-memory-operator-rehearsal',
    version: 1,
    status: pass ? 'PASS' : 'FAIL',
    pass,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    sourceRevision,
    sourceDirty,
    config: evaluationConfig,
    configSha256: createHash('sha256').update(JSON.stringify(evaluationConfig)).digest('hex'),
    durationMs: Number((performance.now() - started).toFixed(3)),
    checkCount: Object.keys(checks).length,
    checks,
  }
} catch (error) {
  report = {
    format: 'dsh-memory-operator-rehearsal',
    version: 1,
    status: 'FAIL',
    pass: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    sourceRevision,
    sourceDirty,
    durationMs: Number((performance.now() - started).toFixed(3)),
    checkCount: Object.keys(checks).length,
    checks,
    error: error instanceof Error ? error.message : String(error),
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1

function run(args) {
  const result = spawnSync(process.execPath, [resolve('lib/cli.js'), ...args], {
    cwd: resolve('.'),
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`CLI ${args[0]} failed with ${String(result.status)}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function parse(value) {
  return JSON.parse(value)
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
