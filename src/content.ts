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
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
]

// Hidden model reasoning and raw orchestration transcripts are not durable
// knowledge. They may contain private context that cannot be made safe by
// redacting a few token-shaped strings, so proposals containing them fail
// closed under both secret policies.
const PRIVATE_CONTEXT_PATTERNS: readonly RegExp[] = [
  /<\s*(?:think|analysis|chain[-_ ]?of[-_ ]?thought)\b/i,
  /\b(?:hidden|private)\s+(?:reasoning|chain[-_ ]?of[-_ ]?thought)\b/i,
  /(?:^|\n)\s*(?:system|developer)\s*(?:message)?\s*:\s*/i,
  /(?:^|\n)\s*(?:user|assistant|tool)\s+(?:message|call|result)\s*:\s*/i,
  /(?:^|\n)\s*(?:system|developer|user|assistant|tool)\s*:\s*/i,
  /["']role["']\s*:\s*["'](?:system|developer|user|assistant|tool)["']/i,
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
    /** Permit reading an already-expired historical working revision. */
    readonly allowExpiredWorking?: boolean
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
  let owner = normalizeText(input.owner, 'owner', 1, 200)
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
    ['owner', owner],
    ...evidence.flatMap((item, index) => [
      [`evidence[${index}].locator`, item.locator],
      ...(item.note === undefined ? [] : [[`evidence[${index}].note`, item.note] as const]),
    ] as const),
  ] as const
  const privateLocations = secretFields.filter(([, value]) => containsPrivateContext(value)).map(([name]) => name)
  if (privateLocations.length > 0) {
    throw new Error(`dsh-memory proposal rejected private transcript or hidden reasoning in ${privateLocations.join(', ')}`)
  }
  const secretLocations = secretFields.filter(([, value]) => containsSecret(value)).map(([name]) => name)
  if (secretLocations.length > 0) {
    if (options.secretPolicy === 'reject') {
      throw new Error(`dsh-memory proposal rejected secret-like content in ${secretLocations.join(', ')}`)
    }
    subject = redactSecrets(subject)
    applicability = redactSecrets(applicability)
    action = redactSecrets(action)
    rationale = redactSecrets(rationale)
    owner = redactSecrets(owner)
    evidence = evidence.map(item => Object.freeze({
      ...item,
      locator: redactSecrets(item.locator),
      ...(item.note === undefined ? {} : { note: redactSecrets(item.note) }),
    }))
  }

  // Redaction is allowed to expand a value (for example, a short token is
  // replaced by a longer marker). Re-apply every persisted field bound after
  // redaction so the value that reaches SQLite is the value we validated.
  if (subject.length > 300 || applicability.length > 2_000 || action.length > 4_000
    || rationale.length > 4_000 || owner.length > 200
    || evidence.some(item => item.locator.length > 2_000 || (item.note !== undefined && item.note.length > 1_000))) {
    throw new Error('dsh-memory proposal exceeds a field limit after secret handling')
  }
  const finalFields = [
    subject, applicability, action, rationale, owner,
    ...evidence.flatMap(item => [item.locator, ...(item.note === undefined ? [] : [item.note])]),
  ]
  if (finalFields.some(value => containsPrivateContext(value) || containsSecret(value))) {
    throw new Error('dsh-memory proposal rejected sensitive content after secret handling')
  }

  const expiresAt = normalizeOptionalTimestamp(input.expiresAt, 'expiresAt')
  if (input.kind === 'working') {
    if (scope.type !== 'session') throw new Error('dsh-memory working records must use session scope')
    if (expiresAt === undefined) throw new Error('dsh-memory working records require expiresAt')
    const maximum = options.now + options.maxWorkingTtlHours * 60 * 60 * 1_000
    if ((!options.allowExpiredWorking && expiresAt <= options.now) || expiresAt > maximum) {
      throw new Error('dsh-memory working record expiresAt is outside the configured TTL window')
    }
  }

  // Redaction can replace a short credential with a longer marker. Enforce
  // the configured bound on the actual value that will be persisted.
  const finalCombinedChars = subject.length + applicability.length + action.length + rationale.length
  if (finalCombinedChars > options.maxChars) {
    throw new Error(`dsh-memory proposal exceeds maxCandidateChars after secret handling (${finalCombinedChars} > ${options.maxChars})`)
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
  const id = normalizeSingleLine(actor.id, 'actor.id', 1, 200)
  if (containsSecret(id)) throw new Error('dsh-memory actor rejected secret-like identifier')
  if (containsPrivateContext(id)) throw new Error('dsh-memory actor rejected private transcript identifier')
  return Object.freeze({ kind: actor.kind, id })
}

export function normalizeScope(scope: MemoryScope): MemoryScope {
  assertObject(scope, 'memory scope')
  if (!ALLOWED_SCOPE_TYPES.has(scope.type)) throw new Error(`dsh-memory: unknown scope ${String(scope.type)}`)
  let key = normalizeSingleLine(scope.key, 'scope.key', 1, 2_000)
  if (containsSecret(key) || containsPrivateContext(key)) {
    throw new Error('dsh-memory scope rejected sensitive content')
  }
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
  const includeGlobal = context.includeGlobal ?? true
  if (typeof includeGlobal !== 'boolean') throw new Error('dsh-memory access includeGlobal must be boolean')
  const maxSensitivity = context.maxSensitivity ?? 'internal'
  if (!ALLOWED_SENSITIVITY.has(maxSensitivity)) {
    throw new Error(`dsh-memory access maxSensitivity is unknown: ${String(maxSensitivity)}`)
  }
  return Object.freeze({
    ...(context.workspace === undefined ? {} : { workspace: canonicalAbsolute(context.workspace, 'workspace') }),
    ...(context.repository === undefined ? {} : { repository: canonicalAbsolute(context.repository, 'repository') }),
    ...(context.session === undefined ? {} : { session: normalizeSafeContextId(context.session, 'session') }),
    ...(context.agent === undefined ? {} : { agent: normalizeSafeContextId(context.agent, 'agent') }),
    ...(context.user === undefined ? {} : { user: normalizeSafeContextId(context.user, 'user') }),
    includeGlobal,
    maxSensitivity,
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

export function containsPrivateContext(value: string): boolean {
  return PRIVATE_CONTEXT_PATTERNS.some(pattern => pattern.test(value))
}

export function redactSecrets(value: string): string {
  let result = value
  for (const pattern of SECRET_PATTERNS) {
    // Patterns are intentionally non-global for safe repeated detection. Keep
    // replacing until there are no further matches so multiple credentials in
    // one field cannot survive a redact-policy admission.
    let previous: string
    do {
      previous = result
      result = result.replace(pattern, '[REDACTED_SECRET]')
    } while (result !== previous)
  }
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
  if (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))) {
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
  const normalized = normalizeSingleLine(value, name, 1, 2_000)
  if (!isAbsolute(normalized)) throw new Error(`dsh-memory access ${name} must be an absolute path`)
  if (containsSecret(normalized) || containsPrivateContext(normalized)) {
    throw new Error(`dsh-memory access ${name} contains sensitive content`)
  }
  return canonicalPath(normalized)
}

function normalizeSafeContextId(value: unknown, name: string): string {
  const result = normalizeSingleLine(value, name, 1, 500)
  if (containsSecret(result) || containsPrivateContext(result)) {
    throw new Error(`dsh-memory access ${name} contains sensitive content`)
  }
  return result
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

function normalizeSingleLine(value: unknown, name: string, minimum: number, maximum: number): string {
  const normalized = normalizeText(value, name, minimum, maximum)
  if (/[\r\n]/.test(normalized)) throw new Error(`dsh-memory ${name} must not contain line breaks`)
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
