import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const output = process.env.DSH_MEMORY_PACK_EVAL_OUTPUT ?? 'evals/reports/pack-smoke-latest.json'
const root = await mkdtemp(join(tmpdir(), 'dsh-memory-pack-'))
const packDirectory = join(root, 'packages')
const consumer = join(root, 'consumer')
const checks = {}
let report
// Sample the source before `pnpm pack` runs lifecycle hooks. The generated
// report itself and reports from another evaluator must not make a clean
// candidate look dirty.
const sourceRevision = process.env.DSH_MEMORY_SOURCE_REVISION ?? git(['rev-parse', 'HEAD']).stdout.trim()
const sourceDirty = git([
  'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)evals/reports/**',
]).stdout.trim().length > 0

try {
  await mkdir(packDirectory, { recursive: true })
  runPnpm(['pack', '--pack-destination', packDirectory])
  const tarballs = (await readdir(packDirectory)).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one packed tarball, found ${tarballs.length}`)
  const tarball = join(packDirectory, tarballs[0])
  const bytes = await readFile(tarball)
  checks.packProduced = bytes.length > 0

  await mkdir(consumer, { recursive: true })
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'dsh-memory-pack-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@muou000/dsh-memory': `file:${tarball.replaceAll('\\', '/')}`,
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-agent': '0.1.1-rc.2',
      '@deepseek-ai/dsh-llm': '0.1.1-rc.2',
      '@deepseek-ai/dsh-session': '0.1.1-rc.2',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
    },
  }, null, 2)}\n`)
  runPnpm(['install', '--ignore-scripts', '--no-frozen-lockfile', '--registry=https://registry.npmjs.org'], consumer)
  checks.cleanInstallFromTarball = true

  const publicProbe = run(process.execPath, ['--input-type=module', '-e', [
    "const api = await import('@muou000/dsh-memory')",
    "if (api.name !== 'dsh-memory' || typeof api.apply !== 'function' || typeof api.MemoryStore !== 'function') process.exit(1)",
    "if (typeof api.MemoryStore.prototype.restoreExport !== 'function') process.exit(1)",
  ].join(';')], consumer)
  checks.publicImport = publicProbe.status === 0
  if (!checks.publicImport) throw new Error(`public import probe failed: ${publicProbe.stderr.trim()}`)

  const packageRoot = join(consumer, 'node_modules', '@muou000', 'dsh-memory')
  const cliProbe = run(process.execPath, [join(packageRoot, 'lib', 'cli.js'), '--help'], consumer)
  checks.cliHelp = cliProbe.status === 0 && cliProbe.stdout.includes('projection-status')
  if (!checks.cliHelp) throw new Error(`CLI probe failed: ${cliProbe.stderr.trim()}`)

  const audit = runPnpm(['audit', '--prod', '--audit-level', 'high', '--registry=https://registry.npmjs.org'], consumer, false)
  checks.productionAudit = audit.status === 0
  if (!checks.productionAudit) throw new Error(`production dependency audit failed: ${audit.stdout.trim()} ${audit.stderr.trim()}`)

  const pass = Object.values(checks).every(Boolean)
  report = {
    format: 'dsh-memory-pack-smoke',
    version: 2,
    status: pass ? 'PASS' : 'FAIL',
    pass,
    releaseEligible: pass && !sourceDirty,
    finishedAt: new Date().toISOString(),
    node: process.version,
    package: tarballs[0].replace(/\.tgz$/, ''),
    tarballSha256: createHash('sha256').update(bytes).digest('hex'),
    tarballBytes: (await stat(tarball)).size,
    sourceRevision,
    sourceDirty,
    checks,
  }
} catch (error) {
  report = {
    format: 'dsh-memory-pack-smoke',
    version: 2,
    status: 'FAIL',
    pass: false,
    releaseEligible: false,
    finishedAt: new Date().toISOString(),
    node: process.version,
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

function runPnpm(args, cwd = resolve('.'), fail = true) {
  const result = process.platform === 'win32'
    ? runWindowsPnpm(args, cwd)
    : run('pnpm', args, cwd)
  if (fail && result.status !== 0) {
    throw new Error(`pnpm ${args[0]} failed with ${String(result.status)}: ${result.stdout.trim()} ${result.stderr.trim()}`)
  }
  return result
}

function runWindowsPnpm(args, cwd) {
  const home = process.env.PNPM_HOME
  const executable = home === undefined ? undefined : join(home, '.tools', 'pnpm-exe', '10.33.0', 'pnpm.exe')
  if (executable !== undefined && existsSync(executable)) return run(executable, args, cwd)
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', ...args], cwd)
}

function git(args) {
  return run('git', args, resolve('.'))
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
}
