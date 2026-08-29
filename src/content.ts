import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import type {
  EvidenceReference,
  MemoryAccessContext,
  MemoryActor,
  MemoryContent,
  MemoryScope,
} from './types.ts'

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
]

const ALLOWED_SCOPE_TYPES = new Set(['global', 'workspace', 'repository', 'session', 'agent', 'user'])
const ALLOWED_KINDS = new Set(['working', 'episodic', 'semantic', 'procedural'])
const ALLOWED_SENSITIVITY = new Set(['public', 'internal', 'confidential'])
const ALLOWED_EVIDENCE = new Set(['session-event', 'file', 'commit', 'test', 'url', 'human'])
const ALLOWED_ACTORS = new Set(['human', 'agent', 'policy', 'migration', 'system'])

/** Validate and normalize a proposal without retaining caller-owned aliases. */
export function normalizeContent(
  input: MemoryContent,
  options: {
    readonly now: number
    readonly maxChars: number
    readonly maxWorkingTtlHours: number
    readonly secretPolicy: 'reject' | 'redact'
  },
): MemoryContent {
  assertObject(input, 'memory content')
  if (!ALLOWED_KINDS.has(input.kind)) throw new Error(`dsh-memory proposal: unknown kind ${String(input.kind)}`)
  if (!ALLOWED_SENSITIVITY.has(input.sensitivity)) {
    throw new Error(`dsh-memory proposal: unknown sensitivity ${String(input.sensitivity)}`)
  }
  const scope = normalizeScope(input.scope)
  let subject = normalizeText(input.subject, 'subject', 1, 300)
  let applicability = normalizeText(input.applicability, 'applicability', 1, 2_000)
  let action = normalizeText(input.action, 'action', 1, 4_000)
  let rationale = normalizeText(input.rationale, 'rationale', 1, 4_000)
  const owner = normalizeText(input.owner, 'owner', 1, 200)
  assertConfidence(input.confidence)
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 50) {
    throw new Error('dsh-memory proposal.evidence must contain 1 to 50 references')
  }
  let evidence = input.evidence.map((item, index) => normalizeEvidence(item, index))

  const combinedChars = subject.length + applicability.length + action.length + rationale.length
  if (combinedChars > options.maxChars) {
    throw new Error(`dsh-memory proposal exceeds maxCandidateChars (${combinedChars} > ${options.maxChars})`)
  }

  const secretFields = [
    ['subject', subject],
    ['applicability', applicability],
    ['action', action],
    ['rationale', rationale],
    ...evidence.flatMap((item, index) => [
      [`evidence[${index}].locator`, item.locator],
      ...(item.note === undefined ? [] : [[`evidence[${index}].note`, item.note] as const]),
    ] as const),
  ] as const
  const secretLocations = secretFields.filter(([, value]) => containsSecret(value)).map(([name]) => name)
  if (secretLocations.length > 0) {
    if (options.secretPolicy === 'reject') {
      throw new Error(`dsh-memory proposal rejected secret-like content in ${secretLocations.join(', ')}`)
    }
    subject = redactSecrets(subject)
    applicability = redactSecrets(applicability)
    action = redactSecrets(action)
    rationale = redactSecrets(rationale)
    evidence = evidence.map(item => Object.freeze({
      ...item,
      locator: redactSecrets(item.locator),
      ...(item.note === undefined ? {} : { note: redactSecrets(item.note) }),
    }))
  }

  const expiresAt = normalizeOptionalTimestamp(input.expiresAt, 'expiresAt')
  if (input.kind === 'working') {
    if (scope.type !== 'session') throw new Error('dsh-memory working records must use session scope')
    if (expiresAt === undefined) throw new Error('dsh-memory working records require expiresAt')
    const maximum = options.now + options.maxWorkingTtlHours * 60 * 60 * 1_000
    if (expiresAt <= options.now || expiresAt > maximum) {
      throw new Error('dsh-memory working record expiresAt is outside the configured TTL window')
    }
  }

  return Object.freeze({
    kind: input.kind,
    scope,
    subject,
    applicability,
    action,
    rationale,
    confidence: input.confidence,
    sensitivity: input.sensitivity,
    owner,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    evidence: Object.freeze(evidence),
  })
}

export function normalizeActor(actor: MemoryActor): MemoryActor {
  assertObject(actor, 'memory actor')
  if (!ALLOWED_ACTORS.has(actor.kind)) throw new Error(`dsh-memory: unknown actor kind ${String(actor.kind)}`)
  return Object.freeze({ kind: actor.kind, id: normalizeText(actor.id, 'actor.id', 1, 200) })
}

export function normalizeScope(scope: MemoryScope): MemoryScope {
  assertObject(scope, 'memory scope')
  if (!ALLOWED_SCOPE_TYPES.has(scope.type)) throw new Error(`dsh-memory: unknown scope ${String(scope.type)}`)
  let key = normalizeText(scope.key, 'scope.key', 1, 2_000)
  if (scope.type === 'global') {
    if (key !== '*') throw new Error('dsh-memory global scope key must be "*"')
  } else if (scope.type === 'workspace' || scope.type === 'repository') {
    if (!isAbsolute(key)) throw new Error(`dsh-memory ${scope.type} scope key must be an absolute path`)
    key = canonicalPath(key)
  }
  return Object.freeze({ type: scope.type, key })
}

export function normalizeAccessContext(context: MemoryAccessContext): MemoryAccessContext {
  assertObject(context, 'memory access context')
  return Object.freeze({
    ...(context.workspace === undefined ? {} : { workspace: canonicalAbsolute(context.workspace, 'workspace') }),
    ...(context.repository === undefined ? {} : { repository: canonicalAbsolute(context.repository, 'repository') }),
    ...(context.session === undefined ? {} : { session: normalizeText(context.session, 'session', 1, 500) }),
    ...(context.agent === undefined ? {} : { agent: normalizeText(context.agent, 'agent', 1, 500) }),
    ...(context.user === undefined ? {} : { user: normalizeText(context.user, 'user', 1, 500) }),
    includeGlobal: context.includeGlobal ?? true,
    maxSensitivity: context.maxSensitivity ?? 'internal',
  })
}

export function contentHash(content: MemoryContent): string {
  const canonical = JSON.stringify({
    kind: content.kind,
    scope: { type: content.scope.type, key: content.scope.key },
    subject: content.subject,
    applicability: content.applicability,
    action: content.action,
    rationale: content.rationale,
    confidence: content.confidence,
    sensitivity: content.sensitivity,
    owner: content.owner,
    expiresAt: content.expiresAt ?? null,
    evidence: content.evidence.map(item => ({
      kind: item.kind,
      locator: item.locator,
      note: item.note ?? null,
      observedAt: item.observedAt ?? null,
      contentHash: item.contentHash ?? null,
    })),
  })
  return sha256(canonical)
}

export function queryHash(query: string): string {
  return sha256(normalizeText(query, 'query', 1, 20_000).toLocaleLowerCase('en-US'))
}

export function canonicalPath(path: string): string {
  const resolved = resolve(normalize(path))
  try {
    return normalize(realpathSync.native(resolved))
  } catch {
    return resolved
  }
}

export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(value))
}

export function redactSecrets(value: string): string {
  let result = value
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[REDACTED_SECRET]')
  return result
}

function normalizeEvidence(input: EvidenceReference, index: number): EvidenceReference {
  assertObject(input, `evidence[${index}]`)
  if (!ALLOWED_EVIDENCE.has(input.kind)) {
    throw new Error(`dsh-memory proposal.evidence[${index}] has unknown kind ${String(input.kind)}`)
  }
  const locator = normalizeText(input.locator, `evidence[${index}].locator`, 1, 2_000)
  const note = input.note === undefined ? undefined : normalizeText(input.note, `evidence[${index}].note`, 1, 1_000)
  const observedAt = normalizeOptionalTimestamp(input.observedAt, `evidence[${index}].observedAt`)
  const hash = input.contentHash
  if (hash !== undefined && !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error(`dsh-memory proposal.evidence[${index}].contentHash must be SHA-256 hex`)
  }
  return Object.freeze({
    kind: input.kind,
    locator,
    ...(note === undefined ? {} : { note }),
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(hash === undefined ? {} : { contentHash: hash.toLowerCase() }),
  })
}

function canonicalAbsolute(value: string, name: string): string {
  const normalized = normalizeText(value, name, 1, 2_000)
  if (!isAbsolute(normalized)) throw new Error(`dsh-memory access ${name} must be an absolute path`)
  return canonicalPath(normalized)
}

function normalizeText(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`dsh-memory ${name} must be a string`)
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(`dsh-memory ${name} length must be in [${minimum}, ${maximum}]`)
  }
  if (/\u0000/.test(normalized)) throw new Error(`dsh-memory ${name} must not contain NUL`)
  return normalized
}

function normalizeOptionalTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dsh-memory ${name} must be a non-negative safe-integer timestamp`)
  }
  return value
}

function assertConfidence(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('dsh-memory proposal.confidence must be a number in [0, 1]')
  }
}

function assertObject(value: unknown, name: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`dsh-memory ${name} must be an object`)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
