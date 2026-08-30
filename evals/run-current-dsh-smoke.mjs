import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const options = parseArgs(process.argv.slice(2))
const pluginRoot = resolve(import.meta.dirname, '..')
const dshRoot = resolve(options.dshRoot)
const dshDirty = gitDirty(dshRoot)
if (dshDirty) throw new Error('current DSH smoke requires a clean upstream checkout')

const [cordis, systemPromptModule, agentModule, toolsModule, memory] = await Promise.all([
  import(pathToFileURL(join(dshRoot, 'vendor', 'cordis', 'lib', 'index.js')).href),
  import(pathToFileURL(join(dshRoot, 'packages', 'core', 'system-prompt', 'lib', 'index.js')).href),
  import(pathToFileURL(join(dshRoot, 'packages', 'core', 'agent', 'lib', 'index.js')).href),
  import(pathToFileURL(join(dshRoot, 'packages', 'core', 'tools', 'lib', 'index.js')).href),
  import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href),
])
const { Context } = cordis
const SystemPrompt = systemPromptModule.default
const AgentRegistry = agentModule.default
const ToolRuntime = toolsModule.default
const root = await mkdtemp(join(tmpdir(), 'dsh-memory-current-dsh-'))
const workspace = join(root, 'workspace')
const context = new Context()
let service
const checks = {
  serviceLoaded: false,
  toolsRegistered: false,
  publicationRoundTrip: false,
  incrementalProjection: false,
  projectionValid: false,
  storeClosedOnDispose: false,
}

try {
  await context.plugin(SystemPrompt, {})
  await context.plugin(AgentRegistry)
  await context.plugin(ToolRuntime, {})
  await context.plugin(memory, { dshHome: root, markdownProjection: true })
  service = context.get('memories')
  checks.serviceLoaded = service !== undefined
  checks.toolsRegistered = ['memory_search', 'memory_read', 'memory_propose', 'memory_feedback']
    .every(name => context.tools.get(name) !== undefined)
  const candidate = service.propose({
    content: {
      kind: 'procedural',
      scope: { type: 'workspace', key: workspace },
      subject: 'Current DSH smoke memory',
      applicability: 'When validating the out-of-tree memory plugin.',
      action: 'Use only public DSH services and release every owned resource.',
      rationale: 'The plugin must remain installable without changing DSH itself.',
      confidence: 0.95,
      sensitivity: 'internal',
      owner: 'dsh-memory-smoke',
      evidence: [{ kind: 'test', locator: 'evals/run-current-dsh-smoke.mjs' }],
    },
    actor: { kind: 'migration', id: 'current-dsh-smoke' },
    now: 1_000,
  })
  const reviewed = service.review(candidate.id, {
    action: 'publish',
    actor: { kind: 'human', id: 'current-dsh-smoke-reviewer' },
    reason: 'Deterministic current DSH compatibility fixture.',
    now: 2_000,
  })
  checks.publicationRoundTrip = reviewed.publishedMemoryId !== undefined
    && service.listRecords().some(record => record.memoryId === reviewed.publishedMemoryId)
  const metrics = service.metrics(3_000)
  checks.incrementalProjection = metrics.projectionFullRebuilds === 1
    && metrics.projectionIncrementalUpdates === 2
  checks.projectionValid = service.projection.verify().valid
} finally {
  await context.fiber.dispose()
  if (service !== undefined) {
    try {
      service.stats()
    } catch (error) {
      checks.storeClosedOnDispose = error instanceof Error && error.message.includes('store is closed')
    }
  }
  await rm(root, { recursive: true, force: true })
}

const report = {
  format: 'dsh-memory-current-dsh-smoke',
  version: 1,
  pluginRevision: gitRevision(pluginRoot),
  pluginDirty: gitDirty(pluginRoot, ['evals/reports/**']),
  dshRevision: gitRevision(dshRoot),
  dshDirty,
  dshAgentVersion: JSON.parse(await readFile(join(dshRoot, 'packages', 'core', 'agent', 'package.json'), 'utf8')).version,
  node: process.version,
  checks,
  pass: Object.values(checks).every(Boolean),
}
await mkdir(dirname(options.output), { recursive: true })
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.pass) process.exitCode = 1

function parseArgs(argv) {
  let dshRoot = process.env.DSH_ROOT
  let output = join(resolve(import.meta.dirname, '..'), 'evals', 'reports', 'current-dsh-smoke-latest.json')
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--dsh-root') {
      dshRoot = argv[index + 1]
      index += 1
    } else if (argument === '--output') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--output requires a path')
      output = isAbsolute(value) ? value : resolve(value)
      index += 1
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  if (dshRoot === undefined) throw new Error('--dsh-root or DSH_ROOT is required')
  return { dshRoot, output }
}

function gitRevision(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function gitDirty(root, exclusions = []) {
  const args = ['status', '--porcelain', '--untracked-files=all', '--', '.', ...exclusions.map(value => `:(exclude)${value}`)]
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim().length > 0
}
