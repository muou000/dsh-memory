/** A governed memory category. DSH session history remains the normal working-memory source. */
export type MemoryKind = 'working' | 'episodic' | 'semantic' | 'procedural'

/** Exact authorization boundary attached to a memory record. */
export type MemoryScopeType = 'global' | 'workspace' | 'repository' | 'session' | 'agent' | 'user'

export interface MemoryScope {
  readonly type: MemoryScopeType
  readonly key: string
}

/** Content sensitivity controls retrieval and export policy. */
export type MemorySensitivity = 'public' | 'internal' | 'confidential'

/** Published-record lifecycle. Candidate lifecycle is represented separately. */
export type MemoryStatus = 'active' | 'conflicted' | 'stale' | 'archived' | 'deleted'

/** Evidence is a locator and digest, never an unrestricted copy of its source. */
export interface EvidenceReference {
  readonly kind: 'session-event' | 'file' | 'commit' | 'test' | 'url' | 'human'
  readonly locator: string
  readonly note?: string
  readonly observedAt?: number
  readonly contentHash?: string
}

/** Stable actor identity included in every write and audit record. */
export interface MemoryActor {
  readonly kind: 'human' | 'agent' | 'policy' | 'migration' | 'system'
  readonly id: string
}

/** Structured content shared by AI rendering and the human Markdown projection. */
export interface MemoryContent {
  readonly kind: MemoryKind
  readonly scope: MemoryScope
  readonly subject: string
  readonly applicability: string
  readonly action: string
  readonly rationale: string
  readonly confidence: number
  readonly sensitivity: MemorySensitivity
  readonly owner: string
  readonly expiresAt?: number
  readonly evidence: readonly EvidenceReference[]
}

/** Immutable record revision. */
export interface MemoryRevision extends MemoryContent {
  readonly memoryId: string
  readonly revision: number
  readonly parentRevision?: number
  readonly operation: MemoryRevisionOperation
  readonly status: MemoryStatus
  readonly actor: MemoryActor
  readonly contentHash: string
  readonly createdAt: number
}

export type MemoryRevisionOperation =
  | 'create'
  | 'update'
  | 'contradict'
  | 'invalidate'
  | 'archive'
  | 'revive'
  | 'delete'

/** Current record head plus usage signals; prior content remains in revisions. */
export interface MemoryRecord extends MemoryRevision {
  readonly status: MemoryStatus
  readonly updatedAt: number
  readonly positiveFeedback: number
  readonly negativeFeedback: number
  readonly useCount: number
  readonly lastUsedAt?: number
}

export type MemoryCandidateOperation = 'create' | 'update' | 'contradict'
export type MemoryCandidateStatus = 'candidate' | 'published' | 'rejected' | 'skipped'

/** Reviewable proposal. A proposal cannot mutate an active record. */
export interface MemoryCandidate {
  readonly id: string
  readonly requestId?: string
  readonly operation: MemoryCandidateOperation
  readonly status: MemoryCandidateStatus
  readonly content: MemoryContent
  readonly actor: MemoryActor
  readonly targetMemoryId?: string
  readonly expectedRevision?: number
  readonly exactDuplicateId?: string
  /** Same-scope lexical suggestions for reviewers; never an automatic merge. */
  readonly similarMemoryIds: readonly string[]
  readonly contentHash: string
  readonly createdAt: number
  readonly reviewedAt?: number
  readonly reviewer?: MemoryActor
  readonly decisionReason?: string
  readonly publishedMemoryId?: string
}

/** Explicit identities available to scope filtering. */
export interface MemoryAccessContext {
  readonly workspace?: string
  readonly repository?: string
  readonly session?: string
  readonly agent?: string
  readonly user?: string
  readonly includeGlobal?: boolean
  readonly maxSensitivity?: MemorySensitivity
}

export interface MemorySearchOptions {
  readonly limit?: number
  readonly now?: number
  readonly kinds?: readonly MemoryKind[]
  readonly includeEvidence?: boolean
}

export interface MemorySearchHit {
  readonly record: MemoryRecord
  readonly score: number
  readonly reasons: readonly string[]
}

export interface MemorySearchResult {
  readonly queryHash: string
  /** Number of scope- and status-eligible candidates before the result limit. */
  readonly candidateCount: number
  readonly hits: readonly MemorySearchHit[]
  readonly durationMs: number
}

export interface MemoryProposalInput {
  readonly operation?: MemoryCandidateOperation
  readonly targetMemoryId?: string
  readonly expectedRevision?: number
  readonly content: MemoryContent
  readonly actor: MemoryActor
  /** Stable caller operation id; retries with the same id return the same candidate. */
  readonly requestId?: string
  readonly now?: number
}

export type MemoryReviewAction = 'publish' | 'reject' | 'skip'

export interface MemoryReviewInput {
  readonly action: MemoryReviewAction
  readonly actor: MemoryActor
  readonly reason: string
  readonly now?: number
}

export interface MemoryTransitionInput {
  readonly action: 'invalidate' | 'archive' | 'revive' | 'delete'
  readonly expectedRevision: number
  readonly actor: MemoryActor
  readonly reason: string
  readonly now?: number
}

export interface MemoryConflict {
  readonly id: string
  readonly leftMemoryId: string
  readonly leftRevision: number
  readonly rightMemoryId: string
  readonly rightRevision: number
  readonly status: 'open' | 'resolved'
  readonly createdAt: number
  readonly resolvedAt?: number
  readonly resolver?: MemoryActor
  readonly resolution?: string
}

export interface MemoryConflictResolutionInput {
  readonly action: 'keep-left' | 'keep-right' | 'keep-both' | 'archive-both'
  readonly actor: MemoryActor
  readonly reason: string
  readonly now?: number
}

export interface MemoryFeedbackInput {
  /** Stable caller operation id; retries with the same id are idempotent. */
  readonly id?: string
  readonly memoryId: string
  readonly revision: number
  readonly kind: 'helpful' | 'harmful' | 'irrelevant' | 'stale'
  readonly actor: MemoryActor
  readonly retrievalId?: string
  readonly note?: string
  readonly now?: number
}

export type MemoryFeedbackKind = MemoryFeedbackInput['kind']

/** Durable retrieval accounting row exported for audit and replay analysis. */
export interface MemoryRetrievalLog {
  readonly id: string
  readonly queryHash: string
  readonly queryText?: string
  readonly context: MemoryAccessContext
  readonly candidateCount: number
  readonly selected: readonly MemorySelectedReference[]
  readonly tokenBudget: number
  readonly estimatedTokens: number
  readonly durationMs: number
  readonly sessionId?: string
  readonly turn?: number
  readonly createdAt: number
}

export interface MemorySelectedReference {
  readonly memoryId: string
  readonly revision: number
  readonly score: number
}

/** Durable feedback row. Feedback is append-only and never rewrites content. */
export interface MemoryFeedbackRecord {
  readonly id: string
  readonly memoryId: string
  readonly revision: number
  readonly retrievalId?: string
  readonly kind: MemoryFeedbackKind
  readonly actor: MemoryActor
  readonly note?: string
  readonly createdAt: number
}

/** Durable, content-free (apart from bounded operator reasons) audit row. */
export interface MemoryAuditRecord {
  readonly seq: number
  readonly createdAt: number
  readonly actor: MemoryActor
  readonly action: string
  readonly entityType: string
  readonly entityId: string
  readonly details: Readonly<Record<string, unknown>>
}

export interface MemoryRetrievalLogInput {
  readonly id: string
  readonly queryHash: string
  readonly queryText?: string
  readonly context: MemoryAccessContext
  readonly candidateCount: number
  readonly selected: readonly { memoryId: string; revision: number; score: number }[]
  readonly tokenBudget: number
  readonly estimatedTokens: number
  readonly durationMs: number
  readonly sessionId?: string
  readonly turn?: number
  readonly now?: number
}

export interface MemoryReadInput {
  readonly memoryId: string
  readonly revision: number
  readonly actor: MemoryActor
  readonly retrievalId?: string
  readonly now?: number
}

export type MemoryMaintenanceReason = 'expired' | 'expiring' | 'negative-feedback' | 'unused'

export interface MemoryMaintenanceOptions {
  readonly now?: number
  /** Nominate records expiring within this many hours. */
  readonly expiringWithinHours?: number
  /** Nominate records whose negative feedback ratio reaches this threshold. */
  readonly negativeFeedbackRatio?: number
  /** Minimum feedback events before the ratio rule applies. */
  readonly minimumFeedbackCount?: number
  /** Nominate records not used for this many days. */
  readonly unusedAfterDays?: number
  /** Maximum nominations returned, after deterministic priority sorting. */
  readonly limit?: number
}

export interface MemoryMaintenanceNomination {
  readonly record: MemoryRecord
  readonly reasons: readonly MemoryMaintenanceReason[]
  readonly priority: 'high' | 'medium' | 'low'
  readonly negativeFeedbackRatio: number
  readonly dueAt?: number
}

export interface MemoryMaintenanceResult {
  readonly evaluatedAt: number
  readonly scanned: number
  readonly nominations: readonly MemoryMaintenanceNomination[]
  readonly expiredCount: number
  readonly expiringCount: number
  readonly negativeFeedbackCount: number
  readonly unusedCount: number
}

export interface MemoryRetentionResult {
  readonly prunedAt: number
  readonly reviewedCandidatesDeleted: number
  readonly retrievalQueryTextsCleared: number
  readonly retrievalsDeleted: number
  readonly feedbackDeleted: number
  readonly auditRowsDeleted: number
}

export interface RenderedMemoryContext {
  readonly text: string
  readonly selected: readonly MemorySearchHit[]
  readonly estimatedTokens: number
}

export interface MemoryExport {
  readonly format: 'dsh-memory-export'
  readonly version: 1
  readonly exportedAt: number
  readonly records: readonly MemoryRecord[]
  readonly revisions: readonly MemoryRevision[]
  readonly candidates: readonly MemoryCandidate[]
  readonly conflicts: readonly MemoryConflict[]
  /** Additive telemetry fields; older v1 exports may omit them. */
  readonly retrievals: readonly MemoryRetrievalLog[]
  readonly feedback: readonly MemoryFeedbackRecord[]
  readonly audit: readonly MemoryAuditRecord[]
}

export interface MemoryHealth {
  readonly state: 'ready' | 'degraded-read-only' | 'unavailable'
  readonly schemaVersion: number
  readonly storePath: string
  readonly projectionPath: string
  readonly integrity: 'ok' | 'failed' | 'not-checked'
  readonly projectionState?: 'ready' | 'disabled' | 'degraded'
  readonly lastProjectionAt?: number
  readonly lastProjectionError?: string
  readonly details?: string
}

export interface MemoryStats {
  readonly recordsByStatus: Readonly<Record<MemoryStatus, number>>
  readonly candidatesByStatus: Readonly<Record<MemoryCandidateStatus, number>>
  readonly openConflicts: number
}

/** Operational counters derived from canonical rows and append-only telemetry. */
export interface MemoryMetrics {
  readonly generatedAt: number
  readonly recordsByStatus: Readonly<Record<MemoryStatus, number>>
  readonly candidatesByStatus: Readonly<Record<MemoryCandidateStatus, number>>
  /** Candidate lifecycle counts, named explicitly for operational dashboards. */
  readonly proposalOutcomes: Readonly<Record<MemoryCandidateStatus, number>>
  readonly openConflicts: number
  readonly pendingCandidateAgeMs?: number
  readonly retrievalCount: number
  readonly retrievalNoHitCount: number
  readonly retrievalNoHitRate: number
  readonly selectedCount: number
  /** Selections that were durably recorded after rendering for delivery. */
  readonly injectedCount: number
  readonly drillDownCount: number
  readonly estimatedTokenTotal: number
  readonly retrievalDurationMs: Readonly<{ p50: number; p95: number; max: number }>
  readonly feedbackByKind: Readonly<Record<MemoryFeedbackKind, number>>
  /** Writer-lock collisions observed by this process for this store path. */
  readonly databaseContentionCount: number
  /** Reserved operational signal; this plugin schedules no background tasks. */
  readonly backgroundTaskFailures: number
  readonly projectionFailures?: number
}
