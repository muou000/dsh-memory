import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { restoreDatabaseBackup } from '../src/backup.ts'
import { MemoryStore } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, proposer, reviewer, temporaryMemoryHome } from './helpers.ts'

const homes: TemporaryMemoryHome[] = []
const stores: MemoryStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const home of homes.splice(0)) home.cleanup()
})

describe('SQLite backup and restore', () => {
  it('round-trips the complete governed store into a new checked database', async () => {
    const sourceHome = temporaryMemoryHome()
    const restoredHome = temporaryMemoryHome()
    homes.push(sourceHome, restoredHome)
    const source = new MemoryStore(sourceHome.config)
    stores.push(source)
    const candidate = source.propose({ content: draft(), actor: proposer, now: 1_000 })
    source.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Verified.', now: 2_000 })
    const backupPath = join(sourceHome.root, 'backups', 'memory.sqlite')
    const restoredPath = join(restoredHome.root, 'restored.sqlite')

    const { createDatabaseBackup } = await import('../src/backup.ts')
    expect(await createDatabaseBackup(source.database, backupPath)).toBeGreaterThan(0)
    expect(await restoreDatabaseBackup(backupPath, restoredPath)).toBeGreaterThan(0)
    expect(existsSync(restoredPath)).toBe(true)

    const restoredConfig = { ...restoredHome.config, storagePath: restoredPath }
    const restored = new MemoryStore(restoredConfig)
    stores.push(restored)
    expect(restored.export(9_000)).toEqual(source.export(9_000))
  })

  it('rejects corrupt input and never overwrites an existing destination', async () => {
    const home = temporaryMemoryHome()
    homes.push(home)
    const corrupt = join(home.root, 'corrupt.sqlite')
    const target = join(home.root, 'target.sqlite')
    writeFileSync(corrupt, 'not sqlite')
    writeFileSync(target, 'keep me')

    await expect(restoreDatabaseBackup(corrupt, join(home.root, 'new.sqlite'))).rejects.toThrow(/restore source/)
    await expect(restoreDatabaseBackup(corrupt, target)).rejects.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('keep me')
  })

  it('restores a validated portable export only into an empty store', () => {
    const sourceHome = temporaryMemoryHome()
    const targetHome = temporaryMemoryHome()
    homes.push(sourceHome, targetHome)
    const source = new MemoryStore(sourceHome.config)
    stores.push(source)
    const candidate = source.propose({ content: draft(), actor: proposer, now: 1_000 })
    source.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Portable export fixture.', now: 2_000 })
    const exported = source.export(9_000)
    const target = new MemoryStore(targetHome.config)
    stores.push(target)
    target.restoreExport(exported)
    expect(target.export(9_000)).toEqual(exported)
    expect(() => target.restoreExport(exported)).toThrow('destination store must be empty')

    const tampered: unknown = structuredClone(exported)
    const tamperedRecord = (tampered as { records: Array<{ action: string }> }).records[0]!
    tamperedRecord.action = 'tampered'
    const emptyHome = temporaryMemoryHome()
    homes.push(emptyHome)
    const empty = new MemoryStore(emptyHome.config)
    stores.push(empty)
    expect(() => empty.restoreExport(tampered)).toThrow('hash mismatch')
    expect(empty.listRecords()).toHaveLength(0)
  })
})
