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
  /** Approximate token ceiling for one model-facing detailed memory read. */
  drillDownTokenBudget?: number
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
  /** Nominate records expiring within this many hours for human review. */
  maintenanceExpiringWithinHours?: number
  /** Nominate records at or above this negative-feedback ratio. */
  maintenanceNegativeFeedbackRatio?: number
  /** Minimum feedback events before the negative-feedback rule applies. */
  maintenanceMinimumFeedbackCount?: number
  /** Nominate records unused for this many days. */
  maintenanceUnusedAfterDays?: number
  /** Maximum maintenance nominations returned in one scan. */
  maintenanceLimit?: number
  /** Minimum deterministic token overlap for a near-duplicate review hint. */
  nearDuplicateThreshold?: number
  /** Maximum same-scope near-duplicate hints stored with one candidate. */
  maxNearDuplicateSuggestions?: number
  /** Days to retain reviewed candidate content; 0 retains it indefinitely. */
  reviewedCandidateRetentionDays?: number
  /** Days to retain opted-in raw query text; 0 retains it indefinitely. */
  queryTextRetentionDays?: number
  /** Days to retain retrieval accounting rows; 0 retains them indefinitely. */
  retrievalRetentionDays?: number
  /** Days to retain feedback rows; 0 retains them indefinitely. */
  feedbackRetentionDays?: number
  /** Days to retain ordinary audit rows; purge/migration proofs are permanent. */
  auditRetentionDays?: number
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
  readonly drillDownTokenBudget: number
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
  readonly maintenanceExpiringWithinHours: number
  readonly maintenanceNegativeFeedbackRatio: number
  readonly maintenanceMinimumFeedbackCount: number
  readonly maintenanceUnusedAfterDays: number
  readonly maintenanceLimit: number
  readonly nearDuplicateThreshold: number
  readonly maxNearDuplicateSuggestions: number
  readonly reviewedCandidateRetentionDays: number
  readonly queryTextRetentionDays: number
  readonly retrievalRetentionDays: number
  readonly feedbackRetentionDays: number
  readonly auditRetentionDays: number
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
  drillDownTokenBudget: z.number().step(1).min(256).max(32_768).default(4_096),
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
  maintenanceExpiringWithinHours: z.number().step(1).min(1).max(24 * 30).default(72),
  maintenanceNegativeFeedbackRatio: z.number().min(0).max(1).default(0.5),
  maintenanceMinimumFeedbackCount: z.number().step(1).min(1).max(100).default(3),
  maintenanceUnusedAfterDays: z.number().step(1).min(1).max(3650).default(90),
  maintenanceLimit: z.number().step(1).min(1).max(1_000).default(100),
  nearDuplicateThreshold: z.number().min(0.1).max(1).default(0.65),
  maxNearDuplicateSuggestions: z.number().step(1).min(0).max(20).default(5),
  reviewedCandidateRetentionDays: z.number().step(1).min(0).max(36_500).default(365),
  queryTextRetentionDays: z.number().step(1).min(0).max(36_500).default(7),
  retrievalRetentionDays: z.number().step(1).min(0).max(36_500).default(180),
  feedbackRetentionDays: z.number().step(1).min(0).max(36_500).default(365),
  auditRetentionDays: z.number().step(1).min(1).max(36_500).default(3_650),
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
  'drillDownTokenBudget',
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
  'maintenanceExpiringWithinHours',
  'maintenanceNegativeFeedbackRatio',
  'maintenanceMinimumFeedbackCount',
  'maintenanceUnusedAfterDays',
  'maintenanceLimit',
  'nearDuplicateThreshold',
  'maxNearDuplicateSuggestions',
  'reviewedCandidateRetentionDays',
  'queryTextRetentionDays',
  'retrievalRetentionDays',
  'feedbackRetentionDays',
  'auditRetentionDays',
])

/** Resolve defaults and cross-field constraints before opening any resource. */
export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  assertPlainObject(config, 'dsh-memory config')
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-memory config: unknown key "${key}"`)
  }

  // `ConfigSchema` validates Loader input, but this public resolver is also
  // called directly by the CLI and embedding applications. Keep that boundary
  // fail-closed instead of relying on TypeScript's erased types.
  assertOptionalString(config.dshHome, 'dshHome')
  assertOptionalString(config.storagePath, 'storagePath')
  assertOptionalString(config.projectionPath, 'projectionPath')
  assertOptionalBoolean(config.readOnly, 'readOnly')
  assertOptionalBoolean(config.integrityCheckOnStart, 'integrityCheckOnStart')
  assertOptionalBoolean(config.autoInject, 'autoInject')
  assertOptionalBoolean(config.logQueryText, 'logQueryText')
  assertOptionalBoolean(config.markdownProjection, 'markdownProjection')
  assertOptionalBoolean(config.logLifecycle, 'logLifecycle')
  if (config.secretPolicy !== undefined
    && config.secretPolicy !== 'reject' && config.secretPolicy !== 'redact') {
    throw new Error(`dsh-memory config.secretPolicy must be reject or redact`)
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
  if (projectionPath === dataPath || projectionPath === storagePath) {
    throw new Error('dsh-memory config.projectionPath must not be the canonical data directory or SQLite file')
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
    drillDownTokenBudget: config.drillDownTokenBudget ?? 4_096,
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
    maintenanceExpiringWithinHours: config.maintenanceExpiringWithinHours ?? 72,
    maintenanceNegativeFeedbackRatio: config.maintenanceNegativeFeedbackRatio ?? 0.5,
    maintenanceMinimumFeedbackCount: config.maintenanceMinimumFeedbackCount ?? 3,
    maintenanceUnusedAfterDays: config.maintenanceUnusedAfterDays ?? 90,
    maintenanceLimit: config.maintenanceLimit ?? 100,
    nearDuplicateThreshold: config.nearDuplicateThreshold ?? 0.65,
    maxNearDuplicateSuggestions: config.maxNearDuplicateSuggestions ?? 5,
    reviewedCandidateRetentionDays: config.reviewedCandidateRetentionDays ?? 365,
    queryTextRetentionDays: config.queryTextRetentionDays ?? 7,
    retrievalRetentionDays: config.retrievalRetentionDays ?? 180,
    feedbackRetentionDays: config.feedbackRetentionDays ?? 365,
    auditRetentionDays: config.auditRetentionDays ?? 3_650,
  } satisfies ResolvedConfig

  assertInteger('busyTimeoutMs', resolved.busyTimeoutMs, 0, 60_000)
  assertInteger('maxInjectedItems', resolved.maxInjectedItems, 1, 20)
  assertInteger('injectionTokenBudget', resolved.injectionTokenBudget, 128, 16_384)
  assertInteger('drillDownTokenBudget', resolved.drillDownTokenBudget, 256, 32_768)
  assertInteger('maxRenderedItemChars', resolved.maxRenderedItemChars, 128, 16_384)
  assertInteger('retrievalCandidateLimit', resolved.retrievalCandidateLimit, 1, 100)
  assertNumber('minConfidence', resolved.minConfidence, 0, 1)
  assertInteger('maxWorkingTtlHours', resolved.maxWorkingTtlHours, 1, 24 * 30)
  assertInteger('maxCandidateChars', resolved.maxCandidateChars, 256, 100_000)
  assertInteger('maintenanceExpiringWithinHours', resolved.maintenanceExpiringWithinHours, 1, 24 * 30)
  assertNumber('maintenanceNegativeFeedbackRatio', resolved.maintenanceNegativeFeedbackRatio, 0, 1)
  assertInteger('maintenanceMinimumFeedbackCount', resolved.maintenanceMinimumFeedbackCount, 1, 100)
  assertInteger('maintenanceUnusedAfterDays', resolved.maintenanceUnusedAfterDays, 1, 3650)
  assertInteger('maintenanceLimit', resolved.maintenanceLimit, 1, 1_000)
  assertNumber('nearDuplicateThreshold', resolved.nearDuplicateThreshold, 0.1, 1)
  assertInteger('maxNearDuplicateSuggestions', resolved.maxNearDuplicateSuggestions, 0, 20)
  assertInteger('reviewedCandidateRetentionDays', resolved.reviewedCandidateRetentionDays, 0, 36_500)
  assertInteger('queryTextRetentionDays', resolved.queryTextRetentionDays, 0, 36_500)
  assertInteger('retrievalRetentionDays', resolved.retrievalRetentionDays, 0, 36_500)
  assertInteger('feedbackRetentionDays', resolved.feedbackRetentionDays, 0, 36_500)
  assertInteger('auditRetentionDays', resolved.auditRetentionDays, 1, 36_500)
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

function assertOptionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`dsh-memory config.${name} must be a string`)
  }
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`dsh-memory config.${name} must be a boolean`)
  }
}

function assertInteger(name: string, value: unknown, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-memory config.${name} must be an integer in [${minimum}, ${maximum}]`)
  }
}

function assertNumber(name: string, value: unknown, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-memory config.${name} must be a number in [${minimum}, ${maximum}]`)
  }
}
