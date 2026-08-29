import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { MemoryKind } from './types.ts'

export interface Config {
  /** Absolute SQLite file path. Omitted uses `<DSH_HOME>/memory/v1/memory.sqlite`. */
  storagePath?: string
  /** Explicit Harness home used only when `storagePath` is omitted. */
  dshHome?: string
  /** Open an existing database without allowing mutation. */
  readOnly?: boolean
  /** SQLite lock wait in milliseconds. */
  busyTimeoutMs?: number
  /** Run `PRAGMA quick_check` while opening the canonical store. */
  integrityCheckOnStart?: boolean
  /** Inject scoped knowledge before the first model request of a turn. */
  autoInject?: boolean
  /** Maximum records in one automatic context block. */
  maxInjectedItems?: number
  /** Approximate token ceiling for one automatic context block. */
  injectionTokenBudget?: number
  /** Maximum characters rendered from one record before deterministic truncation. */
  maxRenderedItemChars?: number
  /** Number of ranked candidates considered before budget selection. */
  retrievalCandidateLimit?: number
  /** Minimum confidence accepted by normal retrieval. */
  minConfidence?: number
  /** Kinds eligible for automatic retrieval. */
  injectedKinds?: MemoryKind[]
  /** Required expiry for working records, in hours. */
  maxWorkingTtlHours?: number
  /** Maximum combined structured text accepted in one candidate. */
  maxCandidateChars?: number
  /** Secret-like proposal handling. */
  secretPolicy?: 'reject' | 'redact'
  /** Persist raw query text in retrieval accounting. Disabled by default. */
  logQueryText?: boolean
  /** Generate the human-readable Markdown projection. */
  markdownProjection?: boolean
  /** Absolute projection directory; omitted uses a sibling `knowledge` directory. */
  projectionPath?: string
  /** Emit lifecycle diagnostics without record content. */
  logLifecycle?: boolean
}

export interface ResolvedConfig {
  readonly storagePath: string
  readonly dataPath: string
  readonly readOnly: boolean
  readonly busyTimeoutMs: number
  readonly integrityCheckOnStart: boolean
  readonly autoInject: boolean
  readonly maxInjectedItems: number
  readonly injectionTokenBudget: number
  readonly maxRenderedItemChars: number
  readonly retrievalCandidateLimit: number
  readonly minConfidence: number
  readonly injectedKinds: readonly MemoryKind[]
  readonly maxWorkingTtlHours: number
  readonly maxCandidateChars: number
  readonly secretPolicy: 'reject' | 'redact'
  readonly logQueryText: boolean
  readonly markdownProjection: boolean
  readonly projectionPath: string
  readonly logLifecycle: boolean
}

const MEMORY_KINDS: readonly MemoryKind[] = ['working', 'episodic', 'semantic', 'procedural']

export const ConfigSchema = z.object({
  storagePath: z.string().default(undefined as unknown as string),
  dshHome: z.string().default(undefined as unknown as string),
  readOnly: z.boolean().default(false),
  busyTimeoutMs: z.number().step(1).min(0).max(60_000).default(5_000),
  integrityCheckOnStart: z.boolean().default(true),
  autoInject: z.boolean().default(true),
  maxInjectedItems: z.number().step(1).min(1).max(20).default(6),
  injectionTokenBudget: z.number().step(1).min(128).max(16_384).default(1_200),
  maxRenderedItemChars: z.number().step(1).min(128).max(16_384).default(1_000),
  retrievalCandidateLimit: z.number().step(1).min(1).max(100).default(24),
  minConfidence: z.number().min(0).max(1).default(0.6),
  injectedKinds: z.array(z.union(MEMORY_KINDS.map(kind => z.const(kind))))
    .default(['episodic', 'semantic', 'procedural']),
  maxWorkingTtlHours: z.number().step(1).min(1).max(24 * 30).default(24),
  maxCandidateChars: z.number().step(1).min(256).max(100_000).default(8_000),
  secretPolicy: z.union(['reject', 'redact']).default('reject'),
  logQueryText: z.boolean().default(false),
  markdownProjection: z.boolean().default(true),
  projectionPath: z.string().default(undefined as unknown as string),
  logLifecycle: z.boolean().default(false),
}) as z<Config>

const CONFIG_KEYS = new Set([
  'storagePath',
  'dshHome',
  'readOnly',
  'busyTimeoutMs',
  'integrityCheckOnStart',
  'autoInject',
  'maxInjectedItems',
  'injectionTokenBudget',
  'maxRenderedItemChars',
  'retrievalCandidateLimit',
  'minConfidence',
  'injectedKinds',
  'maxWorkingTtlHours',
  'maxCandidateChars',
  'secretPolicy',
  'logQueryText',
  'markdownProjection',
  'projectionPath',
  'logLifecycle',
])

/** Resolve defaults and cross-field constraints before opening any resource. */
export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  assertPlainObject(config, 'dsh-memory config')
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-memory config: unknown key "${key}"`)
  }

  const home = config.dshHome ?? env['DSH_HOME'] ?? join(homedir(), '.dsh')
  if (!isAbsolute(home)) throw new Error('dsh-memory config.dshHome must be an absolute path')
  if (config.storagePath !== undefined && !isAbsolute(config.storagePath)) {
    throw new Error('dsh-memory config.storagePath must be an absolute path')
  }
  if (config.projectionPath !== undefined && !isAbsolute(config.projectionPath)) {
    throw new Error('dsh-memory config.projectionPath must be an absolute path')
  }

  const storagePath = resolve(config.storagePath ?? join(home, 'memory', 'v1', 'memory.sqlite'))
  const dataPath = resolve(storagePath, '..')
  const projectionPath = resolve(config.projectionPath ?? join(dataPath, 'knowledge'))
  if (projectionPath === dataPath) {
    throw new Error('dsh-memory config.projectionPath must not be the canonical data directory')
  }

  const injectedKinds = config.injectedKinds ?? ['episodic', 'semantic', 'procedural']
  if (!Array.isArray(injectedKinds) || injectedKinds.length === 0) {
    throw new Error('dsh-memory config.injectedKinds must be a non-empty array')
  }
  if (injectedKinds.some(kind => !MEMORY_KINDS.includes(kind))) {
    throw new Error('dsh-memory config.injectedKinds contains an unknown kind')
  }
  if (new Set(injectedKinds).size !== injectedKinds.length) {
    throw new Error('dsh-memory config.injectedKinds must not contain duplicates')
  }

  const resolved = {
    storagePath,
    dataPath,
    readOnly: config.readOnly ?? false,
    busyTimeoutMs: config.busyTimeoutMs ?? 5_000,
    integrityCheckOnStart: config.integrityCheckOnStart ?? true,
    autoInject: config.autoInject ?? true,
    maxInjectedItems: config.maxInjectedItems ?? 6,
    injectionTokenBudget: config.injectionTokenBudget ?? 1_200,
    maxRenderedItemChars: config.maxRenderedItemChars ?? 1_000,
    retrievalCandidateLimit: config.retrievalCandidateLimit ?? 24,
    minConfidence: config.minConfidence ?? 0.6,
    injectedKinds: Object.freeze([...injectedKinds]),
    maxWorkingTtlHours: config.maxWorkingTtlHours ?? 24,
    maxCandidateChars: config.maxCandidateChars ?? 8_000,
    secretPolicy: config.secretPolicy ?? 'reject',
    logQueryText: config.logQueryText ?? false,
    markdownProjection: config.markdownProjection ?? true,
    projectionPath,
    logLifecycle: config.logLifecycle ?? false,
  } satisfies ResolvedConfig

  assertInteger('busyTimeoutMs', resolved.busyTimeoutMs, 0, 60_000)
  assertInteger('maxInjectedItems', resolved.maxInjectedItems, 1, 20)
  assertInteger('injectionTokenBudget', resolved.injectionTokenBudget, 128, 16_384)
  assertInteger('maxRenderedItemChars', resolved.maxRenderedItemChars, 128, 16_384)
  assertInteger('retrievalCandidateLimit', resolved.retrievalCandidateLimit, 1, 100)
  assertNumber('minConfidence', resolved.minConfidence, 0, 1)
  assertInteger('maxWorkingTtlHours', resolved.maxWorkingTtlHours, 1, 24 * 30)
  assertInteger('maxCandidateChars', resolved.maxCandidateChars, 256, 100_000)
  if (resolved.retrievalCandidateLimit < resolved.maxInjectedItems) {
    throw new Error('dsh-memory config.retrievalCandidateLimit must be >= maxInjectedItems')
  }

  return Object.freeze(resolved)
}

function assertPlainObject(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
}

function assertInteger(name: string, value: unknown, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-memory config.${name} must be an integer in [${minimum}, ${maximum}]`)
  }
}

function assertNumber(name: string, value: unknown, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-memory config.${name} must be a number in [${minimum}, ${maximum}]`)
  }
}
