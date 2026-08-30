import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MemoryStore } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { temporaryMemoryHome } from './helpers.ts'

const homes: TemporaryMemoryHome[] = []
const stores: MemoryStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const home of homes.splice(0)) home.cleanup()
})

describe('writer lock subprocess recovery', () => {
  it('rejects a second process writer and recovers a lock left by a crash', async () => {
    const home = temporaryMemoryHome({ markdownProjection: false })
    homes.push(home)
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'store.ts')).href
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `const { MemoryStore } = await import(process.env.DSH_MEMORY_TEST_MODULE);
       new MemoryStore(JSON.parse(process.env.DSH_MEMORY_TEST_CONFIG));
       process.stdout.write('READY\\n');
       setInterval(() => undefined, 1000);`,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DSH_MEMORY_TEST_MODULE: moduleUrl,
        DSH_MEMORY_TEST_CONFIG: JSON.stringify(home.config),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    try {
      await waitForReady(child)
      expect(() => new MemoryStore(home.config)).toThrow('another writer')
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      const recovered = new MemoryStore(home.config)
      stores.push(recovered)
      expect(recovered.health.state).toBe('ready')
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  }, 15_000)

  it('rolls back an uncommitted canonical transaction after process death', async () => {
    const home = temporaryMemoryHome({ markdownProjection: false })
    homes.push(home)
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'store.ts')).href
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `const { MemoryStore } = await import(process.env.DSH_MEMORY_TEST_MODULE);
       const store = new MemoryStore(JSON.parse(process.env.DSH_MEMORY_TEST_CONFIG));
       store.database.exec("BEGIN IMMEDIATE; INSERT INTO memory_records (id, kind, scope_type, scope_key, status, current_revision, subject, applicability, action_text, rationale, confidence, sensitivity, owner, content_hash, created_at, updated_at) VALUES ('crash-row', 'semantic', 'global', '*', 'active', 1, 'uncommitted', 'fixture', 'fixture', 'fixture', 0.5, 'internal', 'fixture', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 1);");
       process.stdout.write('READY\\n');
       setInterval(() => undefined, 1000);`,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DSH_MEMORY_TEST_MODULE: moduleUrl,
        DSH_MEMORY_TEST_CONFIG: JSON.stringify(home.config),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await waitForReady(child)
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      const recovered = new MemoryStore(home.config)
      stores.push(recovered)
      expect(recovered.health.integrity).toBe('ok')
      expect(recovered.database.prepare("SELECT COUNT(*) AS count FROM memory_records WHERE id = 'crash-row'").get())
        .toMatchObject({ count: 0 })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
    }
  }, 15_000)
})

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout
  const stderr = child.stderr
  if (stdout === null || stderr === null) throw new Error('subprocess streams are unavailable')
  let diagnostics = ''
  stderr.setEncoding('utf8')
  stderr.on('data', chunk => { diagnostics += String(chunk) })
  stdout.setEncoding('utf8')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`writer subprocess did not become ready: ${diagnostics}`)), 10_000)
    const onData = (chunk: string): void => {
      if (!chunk.includes('READY')) return
      clearTimeout(timer)
      stdout.off('data', onData)
      resolve()
    }
    stdout.on('data', onData)
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`writer subprocess exited early (${String(code)}): ${diagnostics}`))
    })
  })
}
