import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabaseBackup, restoreDatabaseBackup } from '../src/backup.ts'
import { CREATE_SCHEMA_SQL } from '../src/schema.ts'
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

  it('rejects an active backup lock and only reclaims a lock from an exited process', async () => {
    const home = temporaryMemoryHome({ markdownProjection: false })
    homes.push(home)
    const source = new MemoryStore(home.config)
    stores.push(source)
    const backupPath = join(home.root, 'locked', 'memory.sqlite')
    const lockPath = `${backupPath}.dsh-memory-operation.lock`

    mkdirForBackup(backupPath)
    writeFileSync(lockPath, `${process.pid}:active`, 'utf8')
    await expect(createDatabaseBackup(source.database, backupPath)).rejects.toThrow('another operation')
    expect(existsSync(lockPath)).toBe(true)
    unlinkSync(lockPath)

    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const childPid = child.pid
    if (childPid === undefined) throw new Error('lock fixture process did not expose a PID')
    await once(child, 'exit')
    writeFileSync(lockPath, `${childPid}:exited`, 'utf8')
    expect(await createDatabaseBackup(source.database, backupPath)).toBeGreaterThan(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('restores a valid older-schema backup for migration on first writable open', async () => {
    const home = temporaryMemoryHome()
    homes.push(home)
    const legacyPath = join(home.root, 'legacy-v1.sqlite')
    const restoredPath = join(home.root, 'restored-v1.sqlite')
    const legacy = new DatabaseSync(legacyPath)
    legacy.exec(CREATE_SCHEMA_SQL)
    legacy.exec('DROP TABLE memory_meta; ALTER TABLE memory_candidates DROP COLUMN similar_memory_ids_json; PRAGMA user_version = 1')
    legacy.close()

    expect(await restoreDatabaseBackup(legacyPath, restoredPath)).toBeGreaterThan(0)
    const migrated = new MemoryStore({ ...home.config, storagePath: restoredPath })
    stores.push(migrated)
    expect((migrated.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
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
    const restoredExport = target.export(9_000)
    expect({ ...restoredExport, audit: exported.audit }).toEqual(exported)
    expect(restoredExport.audit.slice(0, exported.audit.length)).toEqual(exported.audit)
    expect(restoredExport.audit.at(-1)).toMatchObject({ action: 'restore.export' })
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

function mkdirForBackup(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}
