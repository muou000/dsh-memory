import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { STORE_SCHEMA_VERSION } from './schema.ts'

/** Create a checked SQLite snapshot without overwriting an existing path. */
export async function createDatabaseBackup(database: DatabaseSync, destination: string): Promise<number> {
  const path = normalizeDatabasePath(destination, 'backup destination')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const release = acquireOperationLock(`${path}.dsh-memory-operation.lock`)
  try {
    if (existsSync(path)) throw new Error(`dsh-memory backup: destination already exists at ${path}`)
    let pages: number
    try {
      const row = database.prepare('PRAGMA page_count').get() as Record<string, unknown> | undefined
      const pageCount = row === undefined ? undefined : Object.values(row)[0]
      if (typeof pageCount !== 'number') throw new Error('could not read source page count')
      pages = pageCount
      database.prepare('VACUUM INTO ?').run(path)
      chmodSync(path, 0o600)
      validateDatabaseFile(path, 'backup')
    } catch (error) {
      removePartial(path)
      throw withStage(error, 'backup')
    }
    return pages
  } finally {
    release()
  }
}

/** Validate and copy a backup to a new store path while the target plugin is stopped. */
export async function restoreDatabaseBackup(source: string, destination: string): Promise<number> {
  const sourcePath = normalizeDatabasePath(source, 'restore source')
  const destinationPath = normalizeDatabasePath(destination, 'restore destination')
  if (sourcePath === destinationPath) throw new Error('dsh-memory restore: source and destination must differ')
  assertRegularFile(sourcePath, 'restore source')
  const pages = databasePageCount(sourcePath, 'restore source')
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 })
  const release = acquireOperationLock(`${destinationPath}.dsh-memory-operation.lock`)
  try {
    if (existsSync(destinationPath)) {
      throw new Error(`dsh-memory restore: destination already exists at ${destinationPath}`)
    }
    try {
      copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL)
      chmodSync(destinationPath, 0o600)
      validateDatabaseFile(destinationPath, 'restore destination')
    } catch (error) {
      removePartial(destinationPath)
      throw withStage(error, 'restore')
    }
    return pages
  } finally {
    release()
  }
}

export function validateDatabaseFile(pathInput: string, stage = 'validate'): void {
  const path = normalizeDatabasePath(pathInput, stage)
  assertRegularFile(path, stage)
  try {
    const database = new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    })
    try {
    const versionRow = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
    const version = versionRow === undefined ? undefined : Object.values(versionRow)[0]
    if (version !== STORE_SCHEMA_VERSION) {
      throw new Error(`dsh-memory ${stage}: schema version ${String(version)} is not ${STORE_SCHEMA_VERSION}`)
    }
    const checkRow = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (checkRow === undefined || Object.values(checkRow)[0] !== 'ok') {
      throw new Error(`dsh-memory ${stage}: SQLite quick_check failed`)
    }
    } finally {
      database.close()
    }
  } catch (error) {
    throw withStage(error, stage)
  }
}

function databasePageCount(path: string, stage: string): number {
  validateDatabaseFile(path, stage)
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false })
  try {
    const row = database.prepare('PRAGMA page_count').get() as Record<string, unknown> | undefined
    const value = row === undefined ? undefined : Object.values(row)[0]
    if (typeof value !== 'number') throw new Error('could not read page count')
    return value
  } finally {
    database.close()
  }
}

function normalizeDatabasePath(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value)) {
    throw new Error(`dsh-memory ${name}: path must be absolute`)
  }
  return resolve(value)
}

function assertRegularFile(path: string, stage: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    throw new Error(`dsh-memory ${stage}: file does not exist at ${path}`, { cause: error })
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`dsh-memory ${stage}: path must be a regular non-symlink file`)
  }
}

function acquireOperationLock(path: string): () => void {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
    writeFileSync(fd, `${process.pid}:${randomUUID()}`, { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`dsh-memory backup: another operation owns ${path}`, { cause: error })
  }
  closeSync(fd)
  return () => {
    try {
      unlinkSync(path)
    } catch {
      // The operation result remains valid even when stale lock cleanup needs manual repair.
    }
  }
}

function removePartial(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path)
  } catch {
    // No partial file remains.
  }
}

function withStage(error: unknown, stage: string): Error {
  if (error instanceof Error && error.message.startsWith(`dsh-memory ${stage}:`)) return error
  return new Error(`dsh-memory ${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}
