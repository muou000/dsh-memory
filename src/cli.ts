#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Config } from './config.ts'
import { resolveConfig } from './config.ts'
import { restoreDatabaseBackup } from './backup.ts'
import { MarkdownProjection } from './projection.ts'
import { MemoryStore } from './store.ts'
import type { MemoryConflictResolutionInput, MemoryTransitionInput } from './types.ts'

export interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const defaultIo: CliIo = {
  stdout: text => process.stdout.write(`${text}\n`),
  stderr: text => process.stderr.write(`${text}\n`),
}

/** Execute one administrative command. This is intentionally unavailable to model tools. */
export async function runCli(args = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      store: { type: 'string' },
      'dsh-home': { type: 'string' },
      projection: { type: 'string' },
      actor: { type: 'string' },
      reason: { type: 'string' },
      revision: { type: 'string' },
      action: { type: 'string' },
      confirm: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...positionals] = parsed.positionals
  if (parsed.values.help === true || command === undefined || command === 'help') {
    io.stdout(HELP)
    return 0
  }

  if (command === 'restore') {
    requireCount(command, positionals, 2)
    const pages = await restoreDatabaseBackup(positionals[0]!, positionals[1]!)
    output(io, { command, destination: positionals[1], pages })
    return 0
  }
  if (command === 'import') {
    requireCount(command, positionals, 1)
    const config = resolveCliConfig(parsed.values, true)
    const store = new MemoryStore(config)
    try {
      const payload: unknown = JSON.parse(readFileSync(positionals[0]!, 'utf8'))
      store.restoreExport(payload)
      rebuildProjection(store, config, io, command)
      output(io, { command, imported: true, stats: store.stats() })
      return 0
    } finally {
      store.close()
    }
  }

  const writable = !['status', 'projection-status', 'candidates', 'conflicts', 'maintenance', 'metrics', 'audit', 'retrievals', 'feedback', 'export'].includes(command)
  const config = resolveCliConfig(parsed.values, writable)
  const store = new MemoryStore(config)
  try {
    switch (command) {
      case 'status':
        requireCount(command, positionals, 0)
        output(io, { health: store.health, stats: store.stats(), metrics: store.metrics() })
        return 0
      case 'projection-status':
        requireCount(command, positionals, 0)
        output(io, new MarkdownProjection(config).verify())
        return 0
      case 'candidates':
        requireCount(command, positionals, 0)
        output(io, store.listCandidates('candidate'))
        return 0
      case 'conflicts':
        requireCount(command, positionals, 0)
        output(io, store.listConflicts('open'))
        return 0
      case 'maintenance':
        requireCount(command, positionals, 0)
        output(io, store.maintenance())
        return 0
      case 'metrics':
        requireCount(command, positionals, 0)
        output(io, store.metrics())
        return 0
      case 'audit':
        requireCount(command, positionals, 0)
        output(io, store.listAudit())
        return 0
      case 'retrievals':
        requireCount(command, positionals, 0)
        output(io, store.listRetrievals())
        return 0
      case 'feedback':
        requireCount(command, positionals, 0)
        output(io, store.listFeedback())
        return 0
      case 'export':
        requireCount(command, positionals, 0)
        output(io, store.export())
        return 0
      case 'publish':
      case 'reject':
      case 'skip': {
        requireCount(command, positionals, 1)
        const candidate = store.review(positionals[0]!, {
          action: command,
          actor: humanActor(parsed.values.actor),
          reason: requiredOption(parsed.values.reason, 'reason'),
        })
        rebuildProjection(store, config, io, command)
        output(io, candidate)
        return 0
      }
      case 'invalidate':
      case 'archive':
      case 'revive':
      case 'delete': {
        requireCount(command, positionals, 1)
        const input: MemoryTransitionInput = {
          action: command,
          expectedRevision: positiveInteger(parsed.values.revision, 'revision'),
          actor: humanActor(parsed.values.actor),
          reason: requiredOption(parsed.values.reason, 'reason'),
        }
        const record = store.transition(positionals[0]!, input)
        rebuildProjection(store, config, io, command)
        output(io, record)
        return 0
      }
      case 'resolve': {
        requireCount(command, positionals, 1)
        const action = parsed.values.action
        if (!isConflictAction(action)) {
          throw new Error('dsh-memory cli: --action must be keep-left, keep-right, keep-both, or archive-both')
        }
        const input: MemoryConflictResolutionInput = {
          action,
          actor: humanActor(parsed.values.actor),
          reason: requiredOption(parsed.values.reason, 'reason'),
        }
        const conflict = store.resolveConflict(positionals[0]!, input)
        rebuildProjection(store, config, io, command)
        output(io, conflict)
        return 0
      }
      case 'purge': {
        requireCount(command, positionals, 1)
        const id = positionals[0]!
        if (parsed.values.confirm !== id) {
          throw new Error('dsh-memory cli: purge requires --confirm with the exact memory id')
        }
        store.purge(id, humanActor(parsed.values.actor), requiredOption(parsed.values.reason, 'reason'))
        rebuildProjection(store, config, io, command)
        output(io, { command, memoryId: id, purged: true })
        return 0
      }
      case 'prune': {
        requireCount(command, positionals, 0)
        const result = store.prune(
          humanActor(parsed.values.actor),
          requiredOption(parsed.values.reason, 'reason'),
        )
        rebuildProjection(store, config, io, command)
        output(io, { command, ...result })
        return 0
      }
      case 'backup': {
        requireCount(command, positionals, 1)
        const { createDatabaseBackup } = await import('./backup.ts')
        const pages = await createDatabaseBackup(store.database, positionals[0]!)
        output(io, { command, destination: positionals[0], pages })
        return 0
      }
      case 'rebuild':
        requireCount(command, positionals, 0)
        store.rebuildFts()
        rebuildProjection(store, config, io, command)
        output(io, { command, rebuilt: true, stats: store.stats() })
        return 0
      default:
        throw new Error(`dsh-memory cli: unknown command ${command}`)
    }
  } finally {
    store.close()
  }
}

function resolveCliConfig(
  values: Readonly<Record<string, string | boolean | undefined>>,
  writable: boolean,
): ReturnType<typeof resolveConfig> {
  const input: Config = {
    ...(typeof values.store === 'string' ? { storagePath: values.store } : {}),
    ...(typeof values['dsh-home'] === 'string' ? { dshHome: values['dsh-home'] } : {}),
    ...(typeof values.projection === 'string' ? { projectionPath: values.projection } : {}),
    readOnly: !writable,
    markdownProjection: writable,
  }
  return resolveConfig(input)
}

function rebuildProjection(
  store: MemoryStore,
  config: ReturnType<typeof resolveConfig>,
  io: CliIo,
  stage: string,
): void {
  try {
    new MarkdownProjection(config).rebuild(store)
  } catch (error) {
    io.stderr(`dsh-memory projection degraded after ${stage}; canonical mutation committed: ${messageOf(error)}`)
  }
}

function humanActor(value: string | boolean | undefined): { kind: 'human'; id: string } {
  return { kind: 'human', id: requiredOption(value, 'actor') }
}

function requiredOption(value: string | boolean | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`dsh-memory cli: --${name} is required`)
  }
  return value.trim()
}

function positiveInteger(value: string | boolean | undefined, name: string): number {
  const text = requiredOption(value, name)
  const result = Number(text)
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`dsh-memory cli: --${name} must be a positive integer`)
  }
  return result
}

function requireCount(command: string, values: readonly string[], count: number): void {
  if (values.length !== count) {
    throw new Error(`dsh-memory cli: ${command} expects ${count} positional argument${count === 1 ? '' : 's'}`)
  }
}

function isConflictAction(value: unknown): value is MemoryConflictResolutionInput['action'] {
  return value === 'keep-left' || value === 'keep-right' || value === 'keep-both' || value === 'archive-both'
}

function output(io: CliIo, value: unknown): void {
  io.stdout(JSON.stringify(value, null, 2))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const HELP = `dsh-memory administrative CLI

Global location options:
  --store <absolute sqlite path> | --dsh-home <absolute DSH home>
  --projection <absolute Markdown directory>

Read commands:
  status | projection-status | candidates | conflicts | maintenance | metrics | audit | retrievals | feedback | export

Governance commands (require --actor and --reason):
  publish|reject|skip <candidate-id>
  invalidate|archive|revive|delete <memory-id> --revision <n>
  resolve <conflict-id> --action keep-left|keep-right|keep-both|archive-both
  purge <memory-id> --confirm <same-memory-id>
  prune

Operations:
  backup <new-absolute-path>
  restore <backup-absolute-path> <new-store-absolute-path>
  import <export-json-path> (destination store must be empty)
  rebuild`

const mainPath = process.argv[1]
if (mainPath !== undefined && isMainModule(mainPath)) {
  runCli().then(
    code => { process.exitCode = code },
    error => {
      defaultIo.stderr(messageOf(error))
      process.exitCode = 1
    },
  )
}

function isMainModule(path: string): boolean {
  try {
    return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return pathToFileURL(resolve(path)).href === import.meta.url
  }
}
