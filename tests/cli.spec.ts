import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { MemoryStore } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, proposer, temporaryMemoryHome } from './helpers.ts'

const homes: TemporaryMemoryHome[] = []

afterEach(() => {
  for (const home of homes.splice(0)) home.cleanup()
})

describe('administrative CLI', () => {
  it('lets a human inspect and publish a candidate through the canonical state machine', async () => {
    const home = temporaryMemoryHome()
    homes.push(home)
    const seed = new MemoryStore(home.config)
    const candidate = seed.propose({ content: draft(), actor: proposer, now: 1_000 })
    seed.close()
    const stdout: string[] = []
    const stderr: string[] = []
    const io = { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) }

    await expect(runCli(['candidates', '--store', home.config.storagePath], io)).resolves.toBe(0)
    expect(stdout.join('\n')).toContain(candidate.id)
    stdout.length = 0
    await expect(runCli([
      'publish', candidate.id,
      '--store', home.config.storagePath,
      '--actor', 'operator@example',
      '--reason', 'Evidence was checked by the owning team.',
    ], io)).resolves.toBe(0)
    expect(JSON.parse(stdout[0]!) as object).toMatchObject({ status: 'published' })
    expect(stderr).toEqual([])

    stdout.length = 0
    await runCli(['status', '--store', home.config.storagePath], io)
    expect(JSON.parse(stdout[0]!) as object).toMatchObject({ stats: { recordsByStatus: { active: 1 } } })
  })

  it('requires exact confirmation before physical purge', async () => {
    const home = temporaryMemoryHome()
    homes.push(home)
    await expect(runCli([
      'purge', 'memory-id', '--store', home.config.storagePath,
      '--actor', 'operator@example', '--reason', 'Approved deletion.', '--confirm', 'wrong-id',
    ])).rejects.toThrow('exact memory id')
  })

  it('creates an operational backup without overwriting its destination', async () => {
    const home = temporaryMemoryHome()
    homes.push(home)
    const seed = new MemoryStore(home.config)
    seed.close()
    const backup = join(home.root, 'backup', 'memory.sqlite')
    const io = { stdout: () => undefined, stderr: () => undefined }
    await expect(runCli(['backup', backup, '--store', home.config.storagePath], io)).resolves.toBe(0)
    await expect(runCli(['backup', backup, '--store', home.config.storagePath], io)).rejects.toThrow('already exists')
  })
})
