import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
    assertDestinationAbsent(path, 'backup')
    let pages: number
    try {
      const row = database.prepare('PRAGMA page_count').get() as Record<string, unknown> | undefined
      const pageCount = row === undefined ? undefined : Object.values(row)[0]
      if (typeof pageCount !== 'number') throw new Error('could not read source page count')
      pages = pageCount
      validateDatabaseConnection(database, 'backup source')
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
  const pages = databasePageCount(sourcePath, 'restore source', true)
  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 })
  const release = acquireOperationLock(`${destinationPath}.dsh-memory-operation.lock`)
  try {
    assertDestinationAbsent(destinationPath, 'restore')
    try {
      copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL)
      chmodSync(destinationPath, 0o600)
      validateDatabaseFile(destinationPath, 'restore destination', { allowOlderSchema: true })
    } catch (error) {
      removePartial(destinationPath)
      throw withStage(error, 'restore')
    }
    return pages
  } finally {
    release()
  }
}

export function validateDatabaseFile(
  pathInput: string,
  stage = 'validate',
  options: { readonly allowOlderSchema?: boolean } = {},
): void {
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
      const supported = options.allowOlderSchema === true
        ? typeof version === 'number' && Number.isInteger(version) && version >= 1 && version <= STORE_SCHEMA_VERSION
        : version === STORE_SCHEMA_VERSION
      if (!supported) {
        throw new Error(options.allowOlderSchema === true
          ? `dsh-memory ${stage}: schema version ${String(version)} is outside supported migration range 1..${STORE_SCHEMA_VERSION}`
          : `dsh-memory ${stage}: schema version ${String(version)} is not ${STORE_SCHEMA_VERSION}`)
      }
      const checkRow = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      if (checkRow === undefined || Object.values(checkRow)[0] !== 'ok') {
        throw new Error(`dsh-memory ${stage}: SQLite quick_check failed`)
      }
      validateSchemaShape(database, stage, {
        allowOlderSchema: options.allowOlderSchema === true,
        ...(typeof version === 'number' ? { version } : {}),
      })
      const foreignKeyRow = database.prepare('PRAGMA foreign_key_check').get()
      if (foreignKeyRow !== undefined) throw new Error(`dsh-memory ${stage}: SQLite foreign_key_check failed`)
    } finally {
      database.close()
    }
  } catch (error) {
    throw withStage(error, stage)
  }
}

function databasePageCount(path: string, stage: string, allowOlderSchema = false): number {
  validateDatabaseFile(path, stage, { allowOlderSchema })
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
  const token = `${process.pid}:${randomUUID()}`
  const tryOpen = (): number => openSync(path, 'wx', 0o600)
  let fd: number
  try {
    fd = tryOpen()
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw new Error(`dsh-memory backup: could not acquire operation lock ${path}`, { cause: error })
    }
    if (!removeStaleOperationLock(path)) {
      throw new Error(`dsh-memory backup: another operation owns ${path}`, { cause: error })
    }
    try {
      fd = tryOpen()
    } catch (retryError) {
      throw new Error(
        `dsh-memory backup: ${isAlreadyExists(retryError) ? 'another operation owns' : 'could not acquire'} ${path}`,
        { cause: retryError },
      )
    }
  }
  try {
    writeFileSync(fd, token, { encoding: 'utf8' })
    closeSync(fd)
  } catch (error) {
    try { closeSync(fd) } catch { /* preserve the lock failure */ }
    try { unlinkSync(path) } catch { /* preserve the lock failure */ }
    throw new Error(`dsh-memory backup: could not initialize operation lock ${path}`, { cause: error })
  }
  try {
    chmodSync(path, 0o600)
  } catch (error) {
    // Windows may not expose POSIX mode bits. The exclusive create and
    // ownership token still protect the lock there; retain the lock when the
    // platform rejects chmod rather than turning a valid operation into a
    // false failure.
    if (process.platform === 'win32') return releaseOperationLock(path, token)
    try { unlinkSync(path) } catch { /* preserve the permission failure */ }
    throw new Error(`dsh-memory backup: could not secure operation lock ${path}`, { cause: error })
  }
  return releaseOperationLock(path, token)
}

function releaseOperationLock(path: string, token: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const current = readFileSync(path, 'utf8')
      if (current !== token) return
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) return
      unlinkSync(path)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
}

function removeStaleOperationLock(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    const value = readFileSync(path, 'utf8')
    const match = /^(\d+):/.exec(value)
    if (match === null) return false
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function validateDatabaseConnection(database: DatabaseSync, stage: string): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  const version = versionRow === undefined ? undefined : Object.values(versionRow)[0]
  if (version !== STORE_SCHEMA_VERSION) {
    throw new Error(`dsh-memory ${stage}: schema version ${String(version)} is not ${STORE_SCHEMA_VERSION}`)
  }
  const quick = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
  if (quick === undefined || Object.values(quick)[0] !== 'ok') {
    throw new Error(`dsh-memory ${stage}: SQLite quick_check failed`)
  }
  validateSchemaShape(database, stage)
  const foreignKeyRow = database.prepare('PRAGMA foreign_key_check').get()
  if (foreignKeyRow !== undefined) throw new Error(`dsh-memory ${stage}: SQLite foreign_key_check failed`)
}

function validateSchemaShape(
  database: DatabaseSync,
  stage: string,
  options: { readonly allowOlderSchema?: boolean; readonly version?: number } = {},
): void {
  const allowOlderSchema = options.allowOlderSchema === true
  const version = options.version ?? STORE_SCHEMA_VERSION
  const required: Record<string, string[]> = {
    memory_records: [
      'id', 'kind', 'scope_type', 'scope_key', 'status', 'current_revision', 'subject',
      'applicability', 'action_text', 'rationale', 'confidence', 'sensitivity', 'owner',
      'expires_at', 'content_hash', 'created_at', 'updated_at', 'positive_feedback',
      'negative_feedback', 'use_count', 'last_used_at',
    ],
    memory_revisions: [
      'memory_id', 'revision', 'parent_revision', 'operation', 'actor_kind', 'actor_id',
      'kind', 'scope_type', 'scope_key', 'status', 'subject', 'applicability', 'action_text',
      'rationale', 'confidence', 'sensitivity', 'owner', 'expires_at', 'content_hash', 'created_at',
    ],
    memory_evidence: [
      'memory_id', 'revision', 'ordinal', 'kind', 'locator', 'note', 'observed_at', 'content_hash',
    ],
    memory_candidates: [
      'id', 'request_id', 'operation', 'status', 'target_memory_id', 'expected_revision',
      'exact_duplicate_id', 'content_hash', 'content_json', 'actor_kind', 'actor_id', 'created_at',
      'reviewed_at', 'reviewer_kind', 'reviewer_id', 'decision_reason', 'published_memory_id',
    ],
    memory_conflicts: [
      'id', 'left_memory_id', 'left_revision', 'right_memory_id', 'right_revision', 'status',
      'created_at', 'resolved_at', 'resolver_kind', 'resolver_id', 'resolution',
    ],
    memory_retrievals: [
      'id', 'query_hash', 'query_text', 'context_json', 'candidate_count', 'selected_json',
      'token_budget', 'estimated_tokens', 'duration_ms', 'session_id', 'turn_number', 'created_at',
    ],
    memory_feedback: [
      'id', 'memory_id', 'revision', 'retrieval_id', 'kind', 'actor_kind', 'actor_id', 'note', 'created_at',
    ],
    memory_audit: ['seq', 'created_at', 'actor_kind', 'actor_id', 'action', 'entity_type', 'entity_id', 'details_json'],
    memory_fts: ['memory_id', 'subject', 'applicability', 'action_text', 'rationale'],
  }
  if (version === STORE_SCHEMA_VERSION) {
    required.memory_candidates!.push('similar_memory_ids_json')
    required.memory_meta = ['key', 'value']
  } else if (!(allowOlderSchema && version === 1)) {
    throw new Error(`dsh-memory ${stage}: unsupported schema shape for version ${String(version)}`)
  }
  for (const [table, columns] of Object.entries(required)) {
    const object = database.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table) as Record<string, unknown> | undefined
    if (object === undefined || object.type !== 'table') {
      throw new Error(`dsh-memory ${stage}: missing required schema object ${table}`)
    }
    const present = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
        .map(row => row.name)
        .filter((name): name is string => typeof name === 'string'),
    )
    for (const column of columns) {
      if (!present.has(column)) throw new Error(`dsh-memory ${stage}: ${table} is missing column ${column}`)
    }
  }
  const metaObject = database.prepare("SELECT type FROM sqlite_master WHERE name = 'memory_meta'").get() as Record<string, unknown> | undefined
  if (metaObject !== undefined) {
    if (metaObject.type !== 'table') throw new Error(`dsh-memory ${stage}: memory_meta is not a table`)
    const metaColumns = new Set(
      (database.prepare('PRAGMA table_info(memory_meta)').all() as Array<Record<string, unknown>>)
        .map(row => row.name)
        .filter((name): name is string => typeof name === 'string'),
    )
    if (!metaColumns.has('key') || !metaColumns.has('value')) {
      throw new Error(`dsh-memory ${stage}: memory_meta is missing required columns`)
    }
    const meta = database.prepare("SELECT value FROM memory_meta WHERE key = 'schema_format'").get() as Record<string, unknown> | undefined
    if (version === STORE_SCHEMA_VERSION && meta?.value !== String(STORE_SCHEMA_VERSION)) {
      throw new Error(`dsh-memory ${stage}: schema_format is not ${STORE_SCHEMA_VERSION}`)
    }
    if (version === 1 && meta !== undefined && meta.value !== String(STORE_SCHEMA_VERSION)) {
      throw new Error(`dsh-memory ${stage}: schema_format is invalid for a supported backup`)
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

function assertDestinationAbsent(path: string, stage: string): void {
  try {
    lstatSync(path)
    // lstat deliberately sees dangling links too. Never let a backup or
    // restore operation follow a pre-existing link supplied as its target.
    throw new Error(`dsh-memory ${stage}: destination already exists at ${path}`)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
}

function withStage(error: unknown, stage: string): Error {
  if (error instanceof Error && error.message.startsWith(`dsh-memory ${stage}:`)) return error
  return new Error(`dsh-memory ${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ESRCH')
  }
}
