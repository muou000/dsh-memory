import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ResolvedConfig } from './config.ts'
import {
  contentHash,
  containsPrivateContext,
  containsSecret,
  normalizeAccessContext,
  normalizeActor,
  normalizeContent,
  normalizeScope,
  queryHash,
  redactSecrets,
} from './content.ts'
import { CREATE_SCHEMA_SQL, MIGRATE_V1_TO_V2_SQL, STORE_SCHEMA_VERSION } from './schema.ts'
import type {
  EvidenceReference,
  MemoryAccessContext,
  MemoryActor,
  MemoryAuditRecord,
  MemoryCandidate,
  MemoryCandidateOperation,
  MemoryCandidateStatus,
  MemoryConflict,
  MemoryConflictResolutionInput,
  MemoryContent,
  MemoryExport,
  MemoryFeedbackInput,
  MemoryFeedbackKind,
  MemoryFeedbackRecord,
  MemoryHealth,
  MemoryKind,
  MemoryMaintenanceNomination,
  MemoryMaintenanceOptions,
  MemoryMaintenanceReason,
  MemoryMaintenanceResult,
  MemoryMetrics,
  MemoryProposalInput,
  MemoryRecord,
  MemoryReadInput,
  MemoryRetentionResult,
  MemoryRetrievalLog,
  MemoryRetrievalLogInput,
  MemoryReviewInput,
  MemoryRevision,
  MemoryRevisionOperation,
  MemoryScopeType,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySelectedReference,
  MemorySensitivity,
  MemoryStats,
  MemoryStatus,
  MemoryTransitionInput,
} from './types.ts'

type SqlPrimitive = string | number | bigint | null | Uint8Array
type SqlRow = Record<string, SqlPrimitive>

interface RetrievalComparable {
  readonly queryHash: string
  readonly queryText: string | null
  readonly contextJson: string
  readonly candidateCount: number
  readonly selectedJson: string
  readonly tokenBudget: number
  readonly estimatedTokens: number
  readonly sessionId: string | null
  readonly turn: number | null
}

interface RevisionDecodeContext {
  readonly evidenceRows: readonly SqlRow[]
  readonly parentRow?: SqlRow
}

interface RecordDecodeContext extends RevisionDecodeContext {
  readonly revisionRow: SqlRow
  readonly firstRevisionRow: SqlRow
  readonly latestRevision: number
}

const SENSITIVITY_LEVEL: Readonly<Record<MemorySensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
}

// Writer-lock acquisition happens before a store instance exists, so a
// failed contender cannot write a row in the canonical database. Keep a
// process-local counter keyed by the lock path and expose its scope in the
// metrics contract; deployments should aggregate one metric per process.
const writerContentionCounts = new Map<string, number>()

/** Transactional canonical store. All derived views can be rebuilt from this data. */
export class MemoryStore {
  readonly config: ResolvedConfig
  readonly database: DatabaseSync
  readonly health: MemoryHealth

  private closed = false
  private lock: WriterLock | undefined

  constructor(config: ResolvedConfig) {
    this.config = config
    if (config.readOnly && !existsSync(config.storagePath)) {
      throw new Error(`dsh-memory open: read-only store does not exist at ${config.storagePath}`)
    }
    assertCanonicalDatabasePath(config.storagePath)
    if (!config.readOnly) {
      mkdirSync(config.dataPath, { recursive: true, mode: 0o700 })
      tryChmod(config.dataPath, 0o700)
      this.lock = acquireWriterLock(`${config.storagePath}.writer.lock`)
    }

    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(config.storagePath, {
        readOnly: config.readOnly,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
        timeout: config.busyTimeoutMs,
        readBigInts: false,
      })
      this.database = database
      this.configure()
      const integrity = config.integrityCheckOnStart ? this.quickCheck() : 'not-checked'
      if (integrity === 'failed') {
        throw new Error(`dsh-memory integrity: quick_check failed for ${config.storagePath}`)
      }
      if (config.integrityCheckOnStart) this.validateCanonicalState()
      this.health = Object.freeze({
        state: config.readOnly ? 'degraded-read-only' : 'ready',
        schemaVersion: STORE_SCHEMA_VERSION,
        storePath: config.storagePath,
        projectionPath: config.projectionPath,
        integrity,
        ...(config.readOnly ? { details: 'store opened read-only' } : {}),
      })
      if (!config.readOnly) tryChmod(config.storagePath, 0o600)
    } catch (error) {
      try {
        database?.close()
      } finally {
        this.lock?.release()
      }
      throw addStage(error, 'open')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.database.close()
    } finally {
      this.lock?.release()
      this.lock = undefined
    }
  }

  propose(input: MemoryProposalInput): MemoryCandidate {
    this.assertWritable('propose')
    assertObjectInput(input, 'proposal')
    const operation = input.operation ?? 'create'
    assertCandidateOperation(operation)
    const actor = normalizeActor(input.actor)

    const requestId = input.requestId === undefined
      ? undefined
      : normalizeIdentifier(input.requestId, 'requestId')
    // Idempotent retries may bypass current-state checks, but an explicitly
    // supplied clock must still satisfy the public input contract.
    if (input.now !== undefined) normalizeNow(input.now)
    // Resolve an idempotent retry before checking the target's current head or
    // the caller's current clock. A candidate may have been reviewed (and its
    // target advanced) between the original call and a transport retry.
    if (requestId !== undefined) {
      const existing = this.candidateByRequestId(requestId)
      if (existing !== undefined) {
        const retryContent = normalizeContent(input.content, {
          now: existing.createdAt,
          maxChars: this.config.maxCandidateChars,
          maxWorkingTtlHours: this.config.maxWorkingTtlHours,
          secretPolicy: this.config.secretPolicy,
        })
        const retryTargetId = input.targetMemoryId === undefined
          ? undefined
          : normalizeIdentifier(input.targetMemoryId, 'targetMemoryId')
        const retryExpectedRevision = input.expectedRevision === undefined
          ? undefined
          : assertPositiveInteger(input.expectedRevision, 'expectedRevision')
        const sameRequest = existing.contentHash === contentHash(retryContent)
          && existing.operation === operation
          && (existing.targetMemoryId ?? undefined) === retryTargetId
          && (existing.expectedRevision ?? undefined) === retryExpectedRevision
          && existing.actor.kind === actor.kind
          && existing.actor.id === actor.id
        if (sameRequest) return existing
        throw new Error('dsh-memory propose: requestId was already used for different operation data')
      }
    }

    const now = normalizeNow(input.now)
    const content = normalizeContent(input.content, {
      now,
      maxChars: this.config.maxCandidateChars,
      maxWorkingTtlHours: this.config.maxWorkingTtlHours,
      secretPolicy: this.config.secretPolicy,
    })
    const target = this.validateProposalTarget(operation, input.targetMemoryId, input.expectedRevision)
    if (target !== undefined && now < target.record.updatedAt) {
      throw new Error(`dsh-memory propose: candidate timestamp precedes target ${target.id}`)
    }
    if (target !== undefined) assertTargetCompatibility(operation, content, target.record, 'propose')
    const hash = contentHash(content)

    const queuedDuplicate = this.firstRow(
      `SELECT * FROM memory_candidates
       WHERE content_hash = ? AND status = 'candidate' AND operation = ?
       AND COALESCE(target_memory_id, '') = COALESCE(?, '')
       AND COALESCE(expected_revision, 0) = COALESCE(?, 0)
       ORDER BY created_at, id LIMIT 1`,
      hash,
      operation,
      target?.id ?? null,
      target?.revision ?? null,
    )
    if (queuedDuplicate !== undefined) return this.decodeCandidateRow(queuedDuplicate)

    const exactRecord = this.firstRow(
      `SELECT id FROM memory_records
       WHERE content_hash = ? AND kind = ? AND scope_type = ? AND scope_key = ?
         AND status IN ('active', 'conflicted', 'stale', 'archived')
       ORDER BY updated_at DESC, id LIMIT 1`,
      hash,
      content.kind,
      content.scope.type,
      content.scope.key,
    )
    const exactDuplicateId = exactRecord === undefined ? undefined : readString(exactRecord, 'id')
    const similarMemoryIds = exactDuplicateId === undefined
      ? this.findSimilarMemoryIds(content, target?.id, actor.kind === 'agent' ? 'internal' : 'confidential')
      : []
    const candidate: MemoryCandidate = Object.freeze({
      id: randomUUID(),
      ...(requestId === undefined ? {} : { requestId }),
      operation,
      status: exactDuplicateId === undefined ? 'candidate' : 'skipped',
      content,
      actor,
      ...(target === undefined ? {} : { targetMemoryId: target.id, expectedRevision: target.revision }),
      ...(exactDuplicateId === undefined ? {} : { exactDuplicateId }),
      similarMemoryIds: Object.freeze(similarMemoryIds),
      contentHash: hash,
      createdAt: now,
      ...(exactDuplicateId === undefined ? {} : {
        reviewedAt: now,
        reviewer: Object.freeze({ kind: 'policy' as const, id: 'exact-content-dedup' }),
        decisionReason: 'exact content already exists',
      }),
    })

    this.transaction(() => {
      this.database.prepare(
        `INSERT INTO memory_candidates (
          id, request_id, operation, status, target_memory_id, expected_revision,
          exact_duplicate_id, similar_memory_ids_json, content_hash, content_json, actor_kind, actor_id,
          created_at, reviewed_at, reviewer_kind, reviewer_id, decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.id,
        candidate.requestId ?? null,
        candidate.operation,
        candidate.status,
        candidate.targetMemoryId ?? null,
        candidate.expectedRevision ?? null,
        candidate.exactDuplicateId ?? null,
        JSON.stringify(candidate.similarMemoryIds),
        candidate.contentHash,
        JSON.stringify(candidate.content),
        candidate.actor.kind,
        candidate.actor.id,
        candidate.createdAt,
        candidate.reviewedAt ?? null,
        candidate.reviewer?.kind ?? null,
        candidate.reviewer?.id ?? null,
        candidate.decisionReason ?? null,
      )
      this.audit(
        candidate.reviewer ?? actor,
        candidate.status === 'skipped' ? 'candidate.exact-skip' : 'candidate.propose',
        'candidate',
        candidate.id,
        {
          operation,
          targetMemoryId: target?.id ?? null,
          exactDuplicateId: exactDuplicateId ?? null,
          similarMemoryIds,
          scopeType: content.scope.type,
          contentHash: hash,
        },
        now,
      )
    })
    return candidate
  }

  review(candidateId: string, input: MemoryReviewInput): MemoryCandidate {
    this.assertWritable('review')
    assertObjectInput(input, 'review')
    const id = normalizeIdentifier(candidateId, 'candidateId')
    const now = normalizeNow(input.now)
    const reviewer = normalizeActor(input.actor)
    if (reviewer.kind === 'agent') throw new Error('dsh-memory review: agent actors cannot review candidates')
    const reason = normalizeGovernanceReason(input.reason, this.config.secretPolicy, 'review')
    if (!['publish', 'reject', 'skip'].includes(input.action)) {
      throw new Error(`dsh-memory review: unknown action ${String(input.action)}`)
    }

    return this.transaction(() => {
      const candidate = this.requireCandidate(id)
      if (candidate.status !== 'candidate') {
        throw new Error(`dsh-memory review: candidate ${id} is already ${candidate.status}`)
      }
      if (now < candidate.createdAt) {
        throw new Error(`dsh-memory review: review timestamp cannot precede candidate ${id}`)
      }
      if (input.action !== 'publish') {
        const status = input.action === 'reject' ? 'rejected' : 'skipped'
        this.database.prepare(
          `UPDATE memory_candidates SET status = ?, reviewed_at = ?, reviewer_kind = ?,
           reviewer_id = ?, decision_reason = ? WHERE id = ? AND status = 'candidate'`,
        ).run(status, now, reviewer.kind, reviewer.id, reason, id)
        this.audit(reviewer, `candidate.${status}`, 'candidate', id, { reason }, now)
        return this.requireCandidate(id)
      }

      const published = this.publishCandidate(candidate, reviewer, now)
      this.database.prepare(
        `UPDATE memory_candidates SET status = 'published', reviewed_at = ?, reviewer_kind = ?,
         reviewer_id = ?, decision_reason = ?, published_memory_id = ?
         WHERE id = ? AND status = 'candidate'`,
      ).run(now, reviewer.kind, reviewer.id, reason, published.memoryId, id)
      this.audit(reviewer, 'candidate.publish', 'candidate', id, {
        operation: candidate.operation,
        publishedMemoryId: published.memoryId,
        publishedRevision: published.revision,
        reason,
      }, now)
      return this.requireCandidate(id)
    })
  }

  transition(memoryId: string, input: MemoryTransitionInput): MemoryRecord {
    assertObjectInput(input, 'transition')
    assertTransitionAction(input.action)
    this.assertWritable(input.action)
    const id = normalizeIdentifier(memoryId, 'memoryId')
    const actor = normalizeActor(input.actor)
    if (actor.kind === 'agent') throw new Error(`dsh-memory ${input.action}: agent actors are not authorized`)
    const expectedRevision = assertPositiveInteger(input.expectedRevision, 'expectedRevision')
    const now = normalizeNow(input.now)
    const reason = normalizeGovernanceReason(input.reason, this.config.secretPolicy, input.action)
    const targetStatus: Readonly<Record<MemoryTransitionInput['action'], MemoryStatus>> = {
      invalidate: 'stale',
      archive: 'archived',
      revive: 'active',
      delete: 'deleted',
    }
    return this.transaction(() => {
      const current = this.requireRecordUnscoped(id)
      if (current.revision !== expectedRevision) {
        throw new Error(
          `dsh-memory ${input.action}: optimistic revision mismatch for ${id} `
          + `(expected ${expectedRevision}, current ${current.revision})`,
        )
      }
      if (current.status === 'deleted') throw new Error(`dsh-memory ${input.action}: record ${id} is deleted`)
      const allowedFrom: Readonly<Record<MemoryTransitionInput['action'], readonly MemoryStatus[]>> = {
        invalidate: ['active'],
        archive: ['active', 'stale'],
        revive: ['archived', 'stale'],
        delete: ['active', 'stale', 'archived'],
      }
      if (!allowedFrom[input.action].includes(current.status)) {
        throw new Error(`dsh-memory ${input.action}: invalid transition from ${current.status}`)
      }
      if (input.action === 'revive'
        && current.expiresAt !== undefined && current.expiresAt <= now) {
        throw new Error(`dsh-memory revive: memory ${id} has expired; propose a new record instead`)
      }
      const revision = this.insertRevision(
        id,
        current.revision + 1,
        current.revision,
        input.action,
        actor,
        current,
        targetStatus[input.action],
        now,
      )
      this.updateRecordHead(revision, targetStatus[input.action], current)
      if (targetStatus[input.action] === 'active') this.upsertFts(revision)
      else this.removeFts(id)
      this.audit(actor, `record.${input.action}`, 'memory', id, {
        fromRevision: current.revision,
        toRevision: revision.revision,
        reason,
      }, now)
      return this.requireRecordUnscoped(id)
    })
  }

  purge(memoryId: string, actorInput: MemoryActor, reasonInput: string, nowInput?: number): void {
    this.assertWritable('purge')
    const id = normalizeIdentifier(memoryId, 'memoryId')
    const actor = normalizeActor(actorInput)
    if (actor.kind !== 'human' && actor.kind !== 'system') {
      throw new Error('dsh-memory purge: only human or system actors are authorized')
    }
    const reason = normalizeGovernanceReason(reasonInput, this.config.secretPolicy, 'purge')
    const now = normalizeNow(nowInput)
    this.transaction(() => {
      const record = this.requireRecordUnscoped(id)
      if (record.status !== 'deleted') throw new Error('dsh-memory purge: logical delete is required first')
      if (now < record.updatedAt) {
        throw new Error(`dsh-memory purge: timestamp precedes deleted memory ${id}`)
      }
      // Candidate bodies can duplicate or have published this record. Remove
      // every such body during a physical purge; only content-free audit proof
      // remains by policy.
      this.database.prepare(
        `DELETE FROM memory_candidates
         WHERE target_memory_id = ? OR exact_duplicate_id = ? OR published_memory_id = ?`,
      ).run(id, id, id)
      for (const row of this.rows('SELECT id, similar_memory_ids_json FROM memory_candidates')) {
        const values = decodeIdentifierArray(
          parseJson(readString(row, 'similar_memory_ids_json'), 'candidate similar memory ids'),
          'candidate.similarMemoryIds',
        )
        if (!values.includes(id)) continue
        this.database.prepare('UPDATE memory_candidates SET similar_memory_ids_json = ? WHERE id = ?')
          .run(JSON.stringify(values.filter(value => value !== id)), readString(row, 'id'))
      }
      // Retrieval accounting is retained as aggregate evidence, but a purge
      // must not leave a dangling selected reference (or an opted-in query
      // that may quote the purged knowledge). Remove only the purged id so
      // other selected memories remain auditable and exportable.
      for (const row of this.rows('SELECT id, selected_json FROM memory_retrievals')) {
        const retrievalId = readString(row, 'id')
        const selected = decodeSelectedReferences(
          parseJson(readString(row, 'selected_json'), 'retrieval selection'),
        )
        if (!selected.some(item => item.memoryId === id)) continue
        this.database.prepare(
          'UPDATE memory_retrievals SET selected_json = ?, query_text = NULL WHERE id = ?',
        ).run(JSON.stringify(selected.filter(item => item.memoryId !== id)), retrievalId)
      }
      this.removeFts(id)
      this.database.prepare('DELETE FROM memory_records WHERE id = ?').run(id)
      this.audit(actor, 'record.purge', 'memory', id, {
        lastRevision: record.revision,
        lastContentHash: record.contentHash,
        reason,
      }, now)
    })
  }

  /** Return a scoped current record; inactive history requires an explicit trusted opt-in. */
  get(
    memoryId: string,
    access: MemoryAccessContext,
    includeEvidence = true,
    includeInactive = false,
    nowInput?: number,
  ): MemoryRecord | undefined {
    if (typeof includeEvidence !== 'boolean') throw new Error('dsh-memory get includeEvidence must be boolean')
    if (typeof includeInactive !== 'boolean') throw new Error('dsh-memory get includeInactive must be boolean')
    const now = normalizeNow(nowInput)
    const id = normalizeIdentifier(memoryId, 'memoryId')
    const record = this.recordUnscoped(id, includeEvidence)
    const normalizedAccess = normalizeAccessContext(access)
    if (record === undefined || !isVisible(record, normalizedAccess)) return undefined
    if (!includeInactive && (record.status !== 'active' || (record.expiresAt !== undefined && record.expiresAt <= now))) {
      return undefined
    }
    return record
  }

  getCandidate(candidateId: string): MemoryCandidate | undefined {
    const row = this.firstRow('SELECT * FROM memory_candidates WHERE id = ?', normalizeIdentifier(candidateId, 'candidateId'))
    return row === undefined ? undefined : this.decodeCandidateRow(row)
  }

  listCandidates(status: MemoryCandidateStatus = 'candidate'): readonly MemoryCandidate[] {
    assertCandidateStatus(status)
    return this.rows(
      'SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at, id',
      status,
    ).map(row => this.decodeCandidateRow(row))
  }

  listRecords(statuses: readonly MemoryStatus[] = ['active', 'conflicted', 'stale', 'archived']): readonly MemoryRecord[] {
    if (!Array.isArray(statuses)) throw new Error('dsh-memory list-records statuses must be an array')
    if (statuses.length === 0) return []
    for (const status of statuses) assertRecordStatus(status)
    const placeholders = statuses.map(() => '?').join(', ')
    const records = this.rows(
      `SELECT * FROM memory_records WHERE status IN (${placeholders}) ORDER BY scope_type, scope_key, subject, id`,
      ...statuses,
    )
    const currentRevisions = indexUniqueRows(this.rows(
      `SELECT v.* FROM memory_revisions v
       JOIN memory_records r ON r.id = v.memory_id AND r.current_revision = v.revision
       WHERE r.status IN (${placeholders})`,
      ...statuses,
    ), row => readString(row, 'memory_id'), 'current revisions')
    const firstRevisions = indexUniqueRows(this.rows(
      `SELECT v.memory_id, v.created_at FROM memory_revisions v
       JOIN memory_records r ON r.id = v.memory_id
       WHERE v.revision = 1 AND r.status IN (${placeholders})`,
      ...statuses,
    ), row => readString(row, 'memory_id'), 'first revisions')
    const latestRevisions = indexUniqueRows(this.rows(
      `SELECT v.memory_id, MAX(v.revision) AS revision FROM memory_revisions v
       JOIN memory_records r ON r.id = v.memory_id
       WHERE r.status IN (${placeholders}) GROUP BY v.memory_id`,
      ...statuses,
    ), row => readString(row, 'memory_id'), 'latest revisions')
    const parentRevisions = indexUniqueRows(this.rows(
      `SELECT v.* FROM memory_revisions v
       JOIN memory_records r ON r.id = v.memory_id AND v.revision = r.current_revision - 1
       WHERE r.current_revision > 1 AND r.status IN (${placeholders})`,
      ...statuses,
    ), row => readString(row, 'memory_id'), 'parent revisions')
    const evidence = groupEvidenceRows(this.rows(
      `SELECT e.* FROM memory_evidence e
       JOIN memory_records r ON r.id = e.memory_id AND r.current_revision = e.revision
       WHERE r.status IN (${placeholders}) ORDER BY e.memory_id, e.revision, e.ordinal`,
      ...statuses,
    ))
    return records.map(row => {
      const memoryId = readString(row, 'id')
      const revisionRow = currentRevisions.get(memoryId)
      const firstRevisionRow = firstRevisions.get(memoryId)
      const latestRevisionRow = latestRevisions.get(memoryId)
      if (revisionRow === undefined) throw new Error(`dsh-memory decode: missing current revision ${memoryId}`)
      if (firstRevisionRow === undefined) throw new Error(`dsh-memory decode: missing first revision ${memoryId}`)
      if (latestRevisionRow === undefined) throw new Error(`dsh-memory decode: missing latest revision ${memoryId}`)
      const revision = assertPositiveInteger(readNumber(revisionRow, 'revision'), 'record.revision')
      const parentRow = revision === 1 ? undefined : parentRevisions.get(memoryId)
      if (revision > 1 && parentRow === undefined) {
        throw new Error(`dsh-memory decode: missing parent revision ${memoryId}@${revision - 1}`)
      }
      return this.decodeRecordRow(row, true, {
        revisionRow,
        firstRevisionRow,
        latestRevision: assertPositiveInteger(readNumber(latestRevisionRow, 'revision'), 'record.latestRevision'),
        evidenceRows: evidence.get(revisionKey(memoryId, revision)) ?? [],
        ...(parentRow === undefined ? {} : { parentRow }),
      })
    })
  }

  listRevisions(memoryId?: string): readonly MemoryRevision[] {
    const normalizedId = memoryId === undefined ? undefined : normalizeIdentifier(memoryId, 'memoryId')
    const rows = normalizedId === undefined
      ? this.rows('SELECT * FROM memory_revisions ORDER BY memory_id, revision')
      : this.rows(
          'SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision',
          normalizedId,
        )
    const evidenceRows = normalizedId === undefined
      ? this.rows('SELECT * FROM memory_evidence ORDER BY memory_id, revision, ordinal')
      : this.rows(
          'SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY revision, ordinal',
          normalizedId,
        )
    const evidence = groupEvidenceRows(evidenceRows)
    const revisions = indexUniqueRows(
      rows,
      row => revisionKey(readString(row, 'memory_id'), readNumber(row, 'revision')),
      'revisions',
    )
    return rows.map(row => {
      const id = readString(row, 'memory_id')
      const revision = assertPositiveInteger(readNumber(row, 'revision'), 'revision.revision')
      const parentRow = revision === 1 ? undefined : revisions.get(revisionKey(id, revision - 1))
      if (revision > 1 && parentRow === undefined) {
        throw new Error(`dsh-memory decode: missing parent revision ${id}@${revision - 1}`)
      }
      return this.decodeRevisionRow(row, true, {
        evidenceRows: evidence.get(revisionKey(id, revision)) ?? [],
        ...(parentRow === undefined ? {} : { parentRow }),
      })
    })
  }

  listConflicts(status: 'open' | 'resolved' = 'open'): readonly MemoryConflict[] {
    if (status !== 'open' && status !== 'resolved') {
      throw new Error(`dsh-memory list-conflicts: unknown status ${String(status)}`)
    }
    return this.rows(
      'SELECT * FROM memory_conflicts WHERE status = ? ORDER BY created_at, id',
      status,
    ).map(decodeConflictRow)
  }

  /** Read append-only retrieval accounting in stable chronological order. */
  listRetrievals(limit?: number): readonly MemoryRetrievalLog[] {
    const sql = limit === undefined
      ? 'SELECT * FROM memory_retrievals ORDER BY created_at, id'
      : `SELECT * FROM memory_retrievals ORDER BY created_at, id LIMIT ${validatedListLimit(limit, 'retrievals')}`
    return this.rows(sql).map(row => this.decodeRetrievalRow(row))
  }

  /** Read append-only feedback, optionally restricted to one memory. */
  listFeedback(memoryId?: string): readonly MemoryFeedbackRecord[] {
    const rows = memoryId === undefined
      ? this.rows('SELECT * FROM memory_feedback ORDER BY created_at, id')
      : this.rows(
          'SELECT * FROM memory_feedback WHERE memory_id = ? ORDER BY created_at, id',
          normalizeIdentifier(memoryId, 'memoryId'),
        )
    return rows.map(row => this.decodeFeedbackRow(row))
  }

  /** Read the durable audit trail. Details are parsed but never interpreted as instructions. */
  listAudit(limit?: number): readonly MemoryAuditRecord[] {
    const sql = limit === undefined
      ? 'SELECT * FROM memory_audit ORDER BY seq'
      : `SELECT * FROM memory_audit ORDER BY seq LIMIT ${validatedListLimit(limit, 'audit')}`
    return this.rows(sql).map(row => this.decodeAuditRow(row))
  }

  /**
   * Evaluate expiry, inactivity, and negative-feedback rules without mutating
   * canonical records. Operators can review the deterministic nominations and
   * choose an explicit transition.
   * @param recordsInput Internal derived views may reuse an already decoded canonical snapshot.
   */
  maintenance(
    options: MemoryMaintenanceOptions = {},
    recordsInput?: readonly MemoryRecord[],
  ): MemoryMaintenanceResult {
    assertObjectInput(options, 'maintenance')
    const now = normalizeNow(options.now)
    const expiringWithinHours = options.expiringWithinHours ?? this.config.maintenanceExpiringWithinHours
    const negativeFeedbackRatio = options.negativeFeedbackRatio ?? this.config.maintenanceNegativeFeedbackRatio
    const minimumFeedbackCount = options.minimumFeedbackCount ?? this.config.maintenanceMinimumFeedbackCount
    const unusedAfterDays = options.unusedAfterDays ?? this.config.maintenanceUnusedAfterDays
    const limit = options.limit ?? this.config.maintenanceLimit
    assertBoundedNumber(expiringWithinHours, 'maintenance.expiringWithinHours', 1, 24 * 30)
    assertBoundedNumber(negativeFeedbackRatio, 'maintenance.negativeFeedbackRatio', 0, 1)
    assertBoundedInteger(minimumFeedbackCount, 'maintenance.minimumFeedbackCount', 1, 100)
    assertBoundedInteger(unusedAfterDays, 'maintenance.unusedAfterDays', 1, 3650)
    assertBoundedInteger(limit, 'maintenance.limit', 1, 1_000)

    if (recordsInput !== undefined
      && (!Array.isArray(recordsInput) || recordsInput.some(record => record.status !== 'active'))) {
      throw new Error('dsh-memory maintenance records must be an array of active canonical records')
    }
    const records = recordsInput ?? this.listRecords(['active'])
    const expiringCutoff = now + expiringWithinHours * 60 * 60 * 1_000
    const unusedCutoff = now - unusedAfterDays * 86_400_000
    let expiredCount = 0
    let expiringCount = 0
    let negativeFeedbackCount = 0
    let unusedCount = 0
    const nominations: MemoryMaintenanceNomination[] = []
    for (const record of records) {
      const reasons: MemoryMaintenanceReason[] = []
      let dueAt: number | undefined
      if (record.expiresAt !== undefined) {
        if (record.expiresAt <= now) {
          reasons.push('expired')
          dueAt = record.expiresAt
          expiredCount += 1
        } else if (record.expiresAt <= expiringCutoff) {
          reasons.push('expiring')
          dueAt = record.expiresAt
          expiringCount += 1
        }
      }
      const feedbackTotal = record.positiveFeedback + record.negativeFeedback
      const ratio = feedbackTotal === 0 ? 0 : record.negativeFeedback / feedbackTotal
      if (feedbackTotal >= minimumFeedbackCount && ratio >= negativeFeedbackRatio) {
        reasons.push('negative-feedback')
        negativeFeedbackCount += 1
      }
      const lastActivity = record.lastUsedAt ?? record.updatedAt
      if (lastActivity <= unusedCutoff) {
        reasons.push('unused')
        unusedCount += 1
      }
      if (reasons.length === 0) continue
      const priority = reasons.includes('expired') || reasons.includes('negative-feedback')
        ? 'high'
        : reasons.includes('expiring') ? 'medium' : 'low'
      nominations.push(Object.freeze({
        record,
        reasons: Object.freeze(reasons),
        priority,
        negativeFeedbackRatio: ratio,
        ...(dueAt === undefined ? {} : { dueAt }),
      }))
    }
    const priorityRank = { high: 0, medium: 1, low: 2 } as const
    nominations.sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority]
      || (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER)
      || left.record.updatedAt - right.record.updatedAt
      || left.record.memoryId.localeCompare(right.record.memoryId))
    return Object.freeze({
      evaluatedAt: now,
      scanned: records.length,
      nominations: Object.freeze(nominations.slice(0, limit)),
      expiredCount,
      expiringCount,
      negativeFeedbackCount,
      unusedCount,
    })
  }

  /** Apply configured retention to non-canonical operational history. */
  prune(actorInput: MemoryActor, reasonInput: string, nowInput?: number): MemoryRetentionResult {
    this.assertWritable('prune')
    const actor = normalizeActor(actorInput)
    if (actor.kind !== 'human' && actor.kind !== 'system') {
      throw new Error('dsh-memory prune: only human or system actors are authorized')
    }
    const reason = normalizeGovernanceReason(reasonInput, this.config.secretPolicy, 'prune')
    const now = normalizeNow(nowInput)
    return this.transaction(() => {
      let reviewedCandidatesDeleted = 0
      let retrievalQueryTextsCleared = 0
      let retrievalsDeleted = 0
      let feedbackDeleted = 0
      let auditRowsDeleted = 0

      const candidateCutoff = retentionCutoff(now, this.config.reviewedCandidateRetentionDays)
      if (candidateCutoff !== undefined) {
        reviewedCandidatesDeleted = mutationCount(this.database.prepare(
          `DELETE FROM memory_candidates
           WHERE status IN ('published', 'rejected', 'skipped')
             AND reviewed_at IS NOT NULL AND reviewed_at < ?`,
        ).run(candidateCutoff))
      }

      const queryTextCutoff = retentionCutoff(now, this.config.queryTextRetentionDays)
      if (queryTextCutoff !== undefined) {
        retrievalQueryTextsCleared = mutationCount(this.database.prepare(
          'UPDATE memory_retrievals SET query_text = NULL WHERE query_text IS NOT NULL AND created_at < ?',
        ).run(queryTextCutoff))
      }

      const feedbackCutoff = retentionCutoff(now, this.config.feedbackRetentionDays)
      if (feedbackCutoff !== undefined) {
        feedbackDeleted = mutationCount(this.database.prepare(
          'DELETE FROM memory_feedback WHERE created_at < ?',
        ).run(feedbackCutoff))
      }

      const retrievalCutoff = retentionCutoff(now, this.config.retrievalRetentionDays)
      if (retrievalCutoff !== undefined) {
        this.database.prepare(
          `UPDATE memory_feedback SET retrieval_id = NULL
           WHERE retrieval_id IN (SELECT id FROM memory_retrievals WHERE created_at < ?)`,
        ).run(retrievalCutoff)
        retrievalsDeleted = mutationCount(this.database.prepare(
          'DELETE FROM memory_retrievals WHERE created_at < ?',
        ).run(retrievalCutoff))
      }

      if (feedbackDeleted > 0) {
        this.database.exec(
          `UPDATE memory_records SET
            positive_feedback = (SELECT COUNT(*) FROM memory_feedback f WHERE f.memory_id = memory_records.id AND f.kind = 'helpful'),
            negative_feedback = (SELECT COUNT(*) FROM memory_feedback f WHERE f.memory_id = memory_records.id AND f.kind <> 'helpful')`,
        )
      }

      const auditCutoff = retentionCutoff(now, this.config.auditRetentionDays)
      if (auditCutoff !== undefined) {
        auditRowsDeleted = mutationCount(this.database.prepare(
          `DELETE FROM memory_audit
           WHERE created_at < ?
             AND action NOT IN ('record.purge', 'schema.migrate', 'restore.export')`,
        ).run(auditCutoff))
      }

      const result: MemoryRetentionResult = Object.freeze({
        prunedAt: now,
        reviewedCandidatesDeleted,
        retrievalQueryTextsCleared,
        retrievalsDeleted,
        feedbackDeleted,
        auditRowsDeleted,
      })
      this.audit(actor, 'retention.prune', 'store', 'canonical', { ...result, reason }, now)
      return result
    })
  }

  resolveConflict(conflictId: string, input: MemoryConflictResolutionInput): MemoryConflict {
    this.assertWritable('resolve-conflict')
    assertObjectInput(input, 'resolve-conflict')
    const id = normalizeIdentifier(conflictId, 'conflictId')
    const actor = normalizeActor(input.actor)
    if (actor.kind === 'agent') throw new Error('dsh-memory resolve-conflict: agent actors are not authorized')
    const reason = normalizeGovernanceReason(input.reason, this.config.secretPolicy, 'resolve-conflict')
    const now = normalizeNow(input.now)
    if (!['keep-left', 'keep-right', 'keep-both', 'archive-both'].includes(input.action)) {
      throw new Error(`dsh-memory resolve-conflict: unknown action ${String(input.action)}`)
    }
    const resolution = `${input.action}: ${reason}`
    if (resolution.length > 2_000) {
      throw new Error('dsh-memory resolve-conflict: resolution exceeds the 2000-character limit')
    }
    return this.transaction(() => {
      const currentRow = this.firstRow('SELECT * FROM memory_conflicts WHERE id = ?', id)
      if (currentRow === undefined) throw new Error(`dsh-memory resolve-conflict: unknown conflict ${id}`)
      const current = decodeConflictRow(currentRow)
      if (current.status !== 'open') throw new Error(`dsh-memory resolve-conflict: conflict ${id} is already resolved`)
      const left = this.requireRecordUnscoped(current.leftMemoryId)
      const right = this.requireRecordUnscoped(current.rightMemoryId)
      if (left.status !== 'conflicted' || right.status !== 'conflicted') {
        throw new Error(`dsh-memory resolve-conflict: conflict ${id} records are not both conflicted`)
      }
      if (left.revision !== current.leftRevision || right.revision !== current.rightRevision) {
        throw new Error(`dsh-memory resolve-conflict: conflict ${id} no longer points at both current revisions`)
      }
      if (now < left.updatedAt || now < right.updatedAt) {
        throw new Error(`dsh-memory resolve-conflict: resolution timestamp precedes conflict record heads`)
      }
      const statuses: readonly ['active' | 'archived', 'active' | 'archived'] = input.action === 'keep-left'
        ? ['active', 'archived']
        : input.action === 'keep-right'
          ? ['archived', 'active']
          : input.action === 'keep-both'
            ? ['active', 'active']
            : ['archived', 'archived']
      const leftRevision = this.resolveConflictedRecord(left, statuses[0], actor, now)
      const rightRevision = this.resolveConflictedRecord(right, statuses[1], actor, now)
      this.database.prepare(
        `UPDATE memory_conflicts SET status = 'resolved', resolved_at = ?, resolver_kind = ?,
         resolver_id = ?, resolution = ? WHERE id = ? AND status = 'open'`,
      ).run(now, actor.kind, actor.id, resolution, id)
      this.audit(actor, 'conflict.resolve', 'conflict', id, {
        action: input.action,
        reason,
        leftRevision,
        rightRevision,
      }, now)
      return decodeConflictRow(this.firstRow('SELECT * FROM memory_conflicts WHERE id = ?', id)!)
    })
  }

  private resolveConflictedRecord(
    record: MemoryRecord,
    status: 'active' | 'archived',
    actor: MemoryActor,
    now: number,
  ): number {
    if (status === 'active' && record.expiresAt !== undefined && record.expiresAt <= now) {
      throw new Error(`dsh-memory resolve-conflict: memory ${record.memoryId} has expired; propose a new record instead`)
    }
    const revision = this.insertRevision(
      record.memoryId,
      record.revision + 1,
      record.revision,
      status === 'active' ? 'revive' : 'archive',
      actor,
      record,
      status,
      now,
    )
    this.updateRecordHead(revision, status, record)
    if (status === 'active') this.upsertFts(revision)
    else this.removeFts(record.memoryId)
    return revision.revision
  }

  search(queryInput: string, accessInput: MemoryAccessContext, options: MemorySearchOptions = {}): MemorySearchResult {
    const started = performance.now()
    assertObjectInput(options, 'search options')
    const query = normalizeQuery(queryInput)
    const hash = queryHash(query)
    const access = normalizeAccessContext(accessInput)
    const now = normalizeNow(options.now)
    const limit = options.limit ?? this.config.retrievalCandidateLimit
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('dsh-memory search.limit must be an integer in [1, 100]')
    }
    const kinds = options.kinds ?? this.config.injectedKinds
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(kind => !['working', 'episodic', 'semantic', 'procedural'].includes(kind))) {
      throw new Error('dsh-memory search.kinds must be a non-empty list of known kinds')
    }
    if (options.includeEvidence !== undefined && typeof options.includeEvidence !== 'boolean') {
      throw new Error('dsh-memory search.includeEvidence must be boolean')
    }
    const ftsQuery = toFtsQuery(query)
    if (ftsQuery.length === 0) {
      return Object.freeze({ queryHash: hash, candidateCount: 0, hits: [], durationMs: performance.now() - started })
    }

    const { sql: scopeSql, values: scopeValues } = scopePredicate(access)
    const kindPlaceholders = kinds.map(() => '?').join(', ')
    const sensitivity = SENSITIVITY_LEVEL[access.maxSensitivity ?? 'internal']
    const whereSql = `memory_fts MATCH ?
         AND r.status = 'active'
         AND (r.expires_at IS NULL OR r.expires_at > ?)
         AND r.confidence >= ?
         AND r.kind IN (${kindPlaceholders})
         AND CASE r.sensitivity WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END <= ?
         AND (${scopeSql})`
    const whereValues: SqlPrimitive[] = [
      ftsQuery,
      now,
      this.config.minConfidence,
      ...kinds,
      sensitivity,
      ...scopeValues,
    ]
    const countRow = this.firstRow(
      // The startup integrity check enforces one derived FTS row per record;
      // avoid building a temporary DISTINCT set on every warm retrieval.
      `SELECT COUNT(*) AS count
       FROM memory_fts
       JOIN memory_records r ON r.id = memory_fts.memory_id
       WHERE ${whereSql}`,
      ...whereValues,
    )
    const candidateCount = countRow === undefined ? 0 : readNumber(countRow, 'count')
    const rows = this.rows(
      `SELECT r.*, bm25(memory_fts, 8.0, 3.0, 5.0, 1.0) AS lexical_rank
       FROM memory_fts
       JOIN memory_records r ON r.id = memory_fts.memory_id
       WHERE ${whereSql}
       ORDER BY lexical_rank ASC, r.id ASC
       LIMIT ?`,
      ...whereValues,
      limit,
    )

    const needle = query.toLocaleLowerCase('en-US')
    const hits = rows.map(row => {
      const record = this.decodeRecordRow(row, options.includeEvidence ?? false)
      const reasons: string[] = ['full-text']
      const rank = readNumber(row, 'lexical_rank')
      let score = 1 / (1 + Math.max(0, rank))
      if (record.subject.toLocaleLowerCase('en-US').includes(needle)) {
        score += 8
        reasons.push('subject-exact')
      }
      if (record.action.toLocaleLowerCase('en-US').includes(needle)) {
        score += 4
        reasons.push('action-exact')
      }
      score += record.confidence * 2
      score += Math.min(1, record.positiveFeedback * 0.05)
      score -= Math.min(2, record.negativeFeedback * 0.15)
      if (record.evidence.length > 0) score += Math.min(1, record.evidence.length * 0.1)
      const ageDays = Math.max(0, now - record.updatedAt) / 86_400_000
      score += 0.5 / (1 + ageDays / 90)
      return Object.freeze({ record, score: Math.max(0, score), reasons: Object.freeze(reasons) })
    }).sort((left, right) => right.score - left.score
      || left.record.memoryId.localeCompare(right.record.memoryId))

    return Object.freeze({
      queryHash: hash,
      candidateCount,
      hits: Object.freeze(hits.slice(0, limit)),
      durationMs: performance.now() - started,
    })
  }

  recordRetrieval(input: MemoryRetrievalLogInput): void {
    assertObjectInput(input, 'record-retrieval')
    this.assertWritable('record-retrieval')
    const now = normalizeNow(input.now)
    const id = normalizeIdentifier(input.id, 'retrievalId')
    const normalizedQueryHash = normalizeSha256(input.queryHash, 'queryHash')
    const suppliedQueryText = input.queryText === undefined ? undefined : normalizeQuery(input.queryText)
    if (suppliedQueryText !== undefined && queryHash(suppliedQueryText) !== normalizedQueryHash) {
      throw new Error('dsh-memory record-retrieval: queryText does not match queryHash')
    }
    // Query text is an opt-in diagnostic field. Even with that opt-in, never
    // persist a value that looks like a credential or private transcript.
    const queryText = suppliedQueryText !== undefined
      && !containsSecret(suppliedQueryText)
      && !containsPrivateContext(suppliedQueryText)
      ? suppliedQueryText
      : undefined
    const sessionId = input.sessionId === undefined ? undefined : normalizeIdentifier(input.sessionId, 'sessionId')
    const turn = input.turn === undefined ? undefined : assertNonNegativeInteger(input.turn, 'turn')
    const context = normalizeAccessContext(input.context)
    if (!Array.isArray(input.selected)) throw new Error('dsh-memory record-retrieval: selected must be an array')
    if (input.selected.length > 100) throw new Error('dsh-memory record-retrieval: selected may contain at most 100 references')
    const selected = input.selected.map((item, index) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`dsh-memory record-retrieval: selected[${index}] must be an object`)
      }
      return {
        memoryId: normalizeIdentifier(item.memoryId, `selected[${index}].memoryId`),
        revision: assertPositiveInteger(item.revision, `selected[${index}].revision`),
        score: assertNonNegative(item.score, `selected[${index}].score`),
      }
    })
    if (new Set(selected.map(item => revisionKey(item.memoryId, item.revision))).size !== selected.length) {
      throw new Error('dsh-memory record-retrieval: selected references must be unique')
    }
    const candidateCount = assertNonNegativeInteger(input.candidateCount, 'candidateCount')
    if (selected.length > candidateCount) {
      throw new Error('dsh-memory record-retrieval: selected count exceeds candidate count')
    }
    const tokenBudget = assertNonNegativeInteger(input.tokenBudget, 'tokenBudget')
    const estimatedTokens = assertNonNegativeInteger(input.estimatedTokens, 'estimatedTokens')
    if (estimatedTokens > tokenBudget) {
      throw new Error('dsh-memory record-retrieval: estimated tokens exceed token budget')
    }
    const durationMs = assertNonNegative(input.durationMs, 'durationMs')
    const storedQueryText = this.config.logQueryText ? queryText ?? null : null
    const encodedContext = JSON.stringify(context)
    const encodedSelected = JSON.stringify(selected)

    // A retry is identified by its durable id. Check the existing row before
    // validating current record eligibility: a successful retrieval may be
    // replayed after one of its records has since expired or been revised.
    const existingBeforeValidation = this.firstRow('SELECT * FROM memory_retrievals WHERE id = ?', id)
    if (existingBeforeValidation !== undefined) {
      this.decodeRetrievalRow(existingBeforeValidation)
      assertSameRetrieval(existingBeforeValidation, {
        queryHash: normalizedQueryHash,
        queryText: storedQueryText,
        contextJson: encodedContext,
        candidateCount,
        selectedJson: encodedSelected,
        tokenBudget,
        estimatedTokens,
        sessionId: sessionId ?? null,
        turn: turn ?? null,
      }, id)
      return
    }
    for (const item of selected) {
      const record = this.requireRecordUnscoped(item.memoryId)
      if (record.revision !== item.revision || record.status !== 'active'
        || (record.expiresAt !== undefined && record.expiresAt <= now)
        || !isVisible(record, context)) {
        throw new Error(`dsh-memory record-retrieval: selected memory ${item.memoryId}@${item.revision} is not eligible`)
      }
      if (now < record.updatedAt) {
        throw new Error(`dsh-memory record-retrieval: timestamp precedes selected memory ${item.memoryId}@${item.revision}`)
      }
    }
    this.transaction(() => {
      const existing = this.firstRow('SELECT * FROM memory_retrievals WHERE id = ?', id)
      if (existing !== undefined) {
        this.decodeRetrievalRow(existing)
        assertSameRetrieval(existing, {
          queryHash: normalizedQueryHash,
          queryText: storedQueryText,
          contextJson: encodedContext,
          candidateCount,
          selectedJson: encodedSelected,
          tokenBudget,
          estimatedTokens,
          sessionId: sessionId ?? null,
          turn: turn ?? null,
        }, id)
        return
      }
      this.database.prepare(
        `INSERT INTO memory_retrievals (
          id, query_hash, query_text, context_json, candidate_count, selected_json,
          token_budget, estimated_tokens, duration_ms, session_id, turn_number, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        normalizedQueryHash,
        storedQueryText,
        encodedContext,
        candidateCount,
        encodedSelected,
        tokenBudget,
        estimatedTokens,
        durationMs,
        sessionId ?? null,
        turn ?? null,
        now,
      )
      const update = this.database.prepare(
        `UPDATE memory_records SET use_count = use_count + 1,
          last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < ? THEN ? ELSE last_used_at END
         WHERE id = ? AND current_revision = ?`,
      )
      for (const item of selected) {
        if (mutationCount(update.run(now, now, item.memoryId, item.revision)) !== 1) {
          throw new Error(`dsh-memory record-retrieval: selected memory ${item.memoryId}@${item.revision} changed during accounting`)
        }
      }
      this.audit({ kind: 'system', id: 'retrieval-accounting' }, 'retrieval.record', 'retrieval', id, {
        candidateCount,
        selectedCount: selected.length,
        estimatedTokens,
      }, now)
    })
  }

  /** Record a model or human drill-down without retaining the returned content. */
  recordRead(input: MemoryReadInput): void {
    assertObjectInput(input, 'record-read')
    this.assertWritable('record-read')
    const now = normalizeNow(input.now)
    const id = normalizeIdentifier(input.memoryId, 'memoryId')
    const revision = assertPositiveInteger(input.revision, 'revision')
    const actor = normalizeActor(input.actor)
    const retrievalId = input.retrievalId === undefined ? undefined : normalizeIdentifier(input.retrievalId, 'retrievalId')
    this.transaction(() => {
      const record = this.requireRecordUnscoped(id)
      if (record.revision !== revision || record.status !== 'active'
        || (record.expiresAt !== undefined && record.expiresAt <= now)) {
        throw new Error(`dsh-memory record-read: memory ${id}@${revision} is not current and active`)
      }
      if (now < record.updatedAt) {
        throw new Error(`dsh-memory record-read: timestamp precedes memory ${id}@${revision}`)
      }
      if (retrievalId !== undefined) {
        const retrieval = this.firstRow('SELECT selected_json FROM memory_retrievals WHERE id = ?', retrievalId)
        if (retrieval === undefined) throw new Error(`dsh-memory record-read: unknown retrieval ${retrievalId}`)
        const selected = decodeSelectedReferences(parseJson(readString(retrieval, 'selected_json'), 'retrieval selection'))
        if (!selected.some(item => item.memoryId === id && item.revision === revision)) {
          throw new Error(`dsh-memory record-read: retrieval ${retrievalId} did not select ${id}@${revision}`)
        }
      }
      const result = this.database.prepare(
        `UPDATE memory_records SET use_count = use_count + 1,
          last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < ? THEN ? ELSE last_used_at END
         WHERE id = ? AND current_revision = ?`,
      ).run(now, now, id, revision)
      if (mutationCount(result) !== 1) {
        throw new Error(`dsh-memory record-read: memory ${id}@${revision} changed during accounting`)
      }
      this.audit(actor, 'memory.read', 'memory', id, {
        revision,
        retrievalId: retrievalId ?? null,
      }, now)
    })
  }

  feedback(input: MemoryFeedbackInput): void {
    assertObjectInput(input, 'feedback')
    this.assertWritable('feedback')
    const now = normalizeNow(input.now)
    const feedbackId = input.id === undefined ? randomUUID() : normalizeIdentifier(input.id, 'feedbackId')
    const actor = normalizeActor(input.actor)
    const id = normalizeIdentifier(input.memoryId, 'memoryId')
    const revision = assertPositiveInteger(input.revision, 'revision')
    if (!['helpful', 'harmful', 'irrelevant', 'stale'].includes(input.kind)) {
      throw new Error(`dsh-memory feedback: unknown kind ${String(input.kind)}`)
    }
    let note = input.note === undefined ? undefined : normalizeOptionalNote(input.note)
    if (note !== undefined && containsPrivateContext(note)) {
      throw new Error('dsh-memory feedback rejected private transcript note content')
    }
    if (note !== undefined && containsSecret(note)) {
      if (this.config.secretPolicy === 'reject') {
        throw new Error('dsh-memory feedback rejected secret-like note content')
      }
      note = redactSecrets(note)
      if (note.length > 2_000) {
        throw new Error('dsh-memory feedback rejected redacted note exceeding the 2000-character limit')
      }
    }
    const retrievalId = input.retrievalId === undefined ? undefined : normalizeIdentifier(input.retrievalId, 'retrievalId')
    this.transaction(() => {
      const existing = this.firstRow('SELECT * FROM memory_feedback WHERE id = ?', feedbackId)
      if (existing !== undefined) {
        const prior = this.decodeFeedbackRow(existing)
        const same = prior.memoryId === id
          && prior.revision === revision
          && prior.retrievalId === retrievalId
          && prior.kind === input.kind
          && prior.actor.kind === actor.kind
          && prior.actor.id === actor.id
          && prior.note === note
        if (!same) throw new Error(`dsh-memory feedback: id ${feedbackId} already exists with different data`)
        return
      }
      const record = this.requireRecordUnscoped(id)
      if (record.revision !== revision) {
        throw new Error(`dsh-memory feedback: revision ${revision} is not current for ${id}`)
      }
      if (record.status === 'deleted') {
        throw new Error(`dsh-memory feedback: memory ${id} is deleted`)
      }
      if (now < record.updatedAt) {
        throw new Error(`dsh-memory feedback: timestamp precedes memory ${id}@${revision}`)
      }
      if (retrievalId !== undefined) {
        const retrieval = this.firstRow('SELECT selected_json FROM memory_retrievals WHERE id = ?', retrievalId)
        if (retrieval === undefined) throw new Error(`dsh-memory feedback: unknown retrieval ${retrievalId}`)
        const selected = decodeSelectedReferences(parseJson(readString(retrieval, 'selected_json'), 'retrieval selection'))
        if (!selected.some(item => item.memoryId === id && item.revision === revision)) {
          throw new Error(`dsh-memory feedback: retrieval ${retrievalId} did not select ${id}@${revision}`)
        }
      }
      this.database.prepare(
        `INSERT INTO memory_feedback (
          id, memory_id, revision, retrieval_id, kind, actor_kind, actor_id, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(feedbackId, id, revision, retrievalId ?? null, input.kind, actor.kind, actor.id, note ?? null, now)
      if (input.kind === 'helpful') {
        const result = this.database.prepare('UPDATE memory_records SET positive_feedback = positive_feedback + 1 WHERE id = ?').run(id)
        if (mutationCount(result) !== 1) throw new Error(`dsh-memory feedback: memory ${id} changed during accounting`)
      } else {
        const result = this.database.prepare('UPDATE memory_records SET negative_feedback = negative_feedback + 1 WHERE id = ?').run(id)
        if (mutationCount(result) !== 1) throw new Error(`dsh-memory feedback: memory ${id} changed during accounting`)
      }
      this.audit(actor, `feedback.${input.kind}`, 'memory', id, {
        revision,
        retrievalId: retrievalId ?? null,
      }, now)
    })
  }

  stats(): MemoryStats {
    const records = blankRecordCounts()
    for (const row of this.rows('SELECT status, COUNT(*) AS count FROM memory_records GROUP BY status')) {
      const status = readString(row, 'status') as MemoryStatus
      assertRecordStatus(status)
      records[status] = readNumber(row, 'count')
    }
    const candidates = blankCandidateCounts()
    for (const row of this.rows('SELECT status, COUNT(*) AS count FROM memory_candidates GROUP BY status')) {
      const status = readString(row, 'status') as MemoryCandidateStatus
      assertCandidateStatus(status)
      candidates[status] = readNumber(row, 'count')
    }
    const conflict = this.firstRow("SELECT COUNT(*) AS count FROM memory_conflicts WHERE status = 'open'")
    return Object.freeze({
      recordsByStatus: Object.freeze(records),
      candidatesByStatus: Object.freeze(candidates),
      openConflicts: conflict === undefined ? 0 : readNumber(conflict, 'count'),
    })
  }

  /** Return deterministic operational counters for dashboards and release reports. */
  metrics(nowInput?: number): MemoryMetrics {
    const now = normalizeNow(nowInput)
    const stats = this.stats()
    const retrievalRow = this.firstRow(
      `SELECT COUNT(*) AS retrieval_count,
        COALESCE(SUM(CASE WHEN json_array_length(selected_json) = 0 THEN 1 ELSE 0 END), 0) AS no_hit_count,
        COALESCE(SUM(json_array_length(selected_json)), 0) AS selected_count,
        COALESCE(SUM(estimated_tokens), 0) AS token_total,
        COALESCE(MAX(duration_ms), 0) AS maximum
       FROM memory_retrievals`,
    )
    const retrievalCount = retrievalRow === undefined ? 0 : readNumber(retrievalRow, 'retrieval_count')
    const noHitCount = retrievalRow === undefined ? 0 : readNumber(retrievalRow, 'no_hit_count')
    const selectedCount = retrievalRow === undefined ? 0 : readNumber(retrievalRow, 'selected_count')
    const estimatedTokenTotal = retrievalRow === undefined ? 0 : readNumber(retrievalRow, 'token_total')
    const maximumDuration = retrievalRow === undefined ? 0 : readNumber(retrievalRow, 'maximum')
    const feedbackByKind = blankFeedbackCounts()
    for (const row of this.rows('SELECT kind, COUNT(*) AS count FROM memory_feedback GROUP BY kind')) {
      const kind = readString(row, 'kind') as MemoryFeedbackKind
      assertFeedbackKind(kind)
      feedbackByKind[kind] = readNumber(row, 'count')
    }
    const oldestCandidate = this.firstRow("SELECT MIN(created_at) AS created_at FROM memory_candidates WHERE status = 'candidate'")
    const oldestAt = oldestCandidate === undefined ? undefined : readOptionalNumber(oldestCandidate, 'created_at')
    const drillDown = this.firstRow("SELECT COUNT(*) AS count FROM memory_audit WHERE action = 'memory.read'")
    return Object.freeze({
      generatedAt: now,
      recordsByStatus: stats.recordsByStatus,
      candidatesByStatus: stats.candidatesByStatus,
      proposalOutcomes: stats.candidatesByStatus,
      openConflicts: stats.openConflicts,
      ...(oldestAt === undefined ? {} : { pendingCandidateAgeMs: Math.max(0, now - oldestAt) }),
      retrievalCount,
      retrievalNoHitCount: noHitCount,
      retrievalNoHitRate: retrievalCount === 0 ? 0 : noHitCount / retrievalCount,
      selectedCount,
      injectedCount: selectedCount,
      drillDownCount: drillDown === undefined ? 0 : readNumber(drillDown, 'count'),
      estimatedTokenTotal,
      retrievalDurationMs: Object.freeze({
        p50: this.retrievalDurationPercentile(retrievalCount, 0.5),
        p95: this.retrievalDurationPercentile(retrievalCount, 0.95),
        max: maximumDuration,
      }),
      feedbackByKind: Object.freeze(feedbackByKind),
      databaseContentionCount: writerContentionCounts.get(`${this.config.storagePath}.writer.lock`) ?? 0,
      // Projection and retrieval work are synchronous and lifecycle-owned;
      // there is intentionally no untracked background queue to fail.
      backgroundTaskFailures: 0,
    })
  }

  private retrievalDurationPercentile(count: number, fraction: number): number {
    if (count === 0) return 0
    const offset = Math.min(count - 1, Math.max(0, Math.ceil(count * fraction) - 1))
    const row = this.firstRow(
      `SELECT duration_ms FROM memory_retrievals ORDER BY duration_ms, id LIMIT 1 OFFSET ${offset}`,
    )
    return row === undefined ? 0 : readNumber(row, 'duration_ms')
  }

  export(nowInput?: number): MemoryExport {
    const now = normalizeNow(nowInput)
    return Object.freeze({
      format: 'dsh-memory-export',
      version: 1,
      exportedAt: now,
      records: Object.freeze(this.listRecords(['active', 'conflicted', 'stale', 'archived', 'deleted'])),
      revisions: Object.freeze(this.listRevisions()),
      candidates: Object.freeze([
        ...this.listCandidates('candidate'),
        ...this.listCandidates('published'),
        ...this.listCandidates('rejected'),
        ...this.listCandidates('skipped'),
      ]),
      conflicts: Object.freeze([...this.listConflicts('open'), ...this.listConflicts('resolved')]),
      retrievals: Object.freeze(this.listRetrievals()),
      feedback: Object.freeze(this.listFeedback()),
      audit: Object.freeze(this.listAudit()),
    })
  }

  /** Restore a portable export into an empty store after validating every reference. */
  restoreExport(input: unknown): void {
    this.assertWritable('restore-export')
    const feedbackProvided = isDefinedExportField(input, 'feedback')
    const exportValue = validateExport(input, this.config)
    // Legacy portable exports predate feedback rows. Reset their denormalized
    // counters so the restored store remains internally verifiable on restart;
    // an audit marker records that the aggregate could not be reconstructed.
    const records = feedbackProvided
      ? exportValue.records
      : exportValue.records.map(record => Object.freeze({
          ...record,
          positiveFeedback: 0,
          negativeFeedback: 0,
        }))
    const existing = this.firstRow(
      `SELECT (SELECT COUNT(*) FROM memory_records)
        + (SELECT COUNT(*) FROM memory_revisions)
        + (SELECT COUNT(*) FROM memory_candidates)
        + (SELECT COUNT(*) FROM memory_conflicts)
        + (SELECT COUNT(*) FROM memory_retrievals)
        + (SELECT COUNT(*) FROM memory_feedback)
        + (SELECT COUNT(*) FROM memory_audit)
        + (SELECT COUNT(*) FROM memory_fts) AS count`,
    )
    if (existing !== undefined && readNumber(existing, 'count') !== 0) {
      throw new Error('dsh-memory restore-export: destination store must be empty')
    }
    this.transaction(() => {
      for (const record of records) {
        this.insertExportRecord(record)
      }
      for (const revision of exportValue.revisions) {
        this.insertExportRevision(revision)
      }
      for (const candidate of exportValue.candidates) {
        this.database.prepare(
          `INSERT INTO memory_candidates (
            id, request_id, operation, status, target_memory_id, expected_revision,
            exact_duplicate_id, similar_memory_ids_json, content_hash, content_json, actor_kind, actor_id,
            created_at, reviewed_at, reviewer_kind, reviewer_id, decision_reason, published_memory_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidate.id,
          candidate.requestId ?? null,
          candidate.operation,
          candidate.status,
          candidate.targetMemoryId ?? null,
          candidate.expectedRevision ?? null,
          candidate.exactDuplicateId ?? null,
          JSON.stringify(candidate.similarMemoryIds),
          candidate.contentHash,
          JSON.stringify(candidate.content),
          candidate.actor.kind,
          candidate.actor.id,
          candidate.createdAt,
          candidate.reviewedAt ?? null,
          candidate.reviewer?.kind ?? null,
          candidate.reviewer?.id ?? null,
          candidate.decisionReason ?? null,
          candidate.publishedMemoryId ?? null,
        )
      }
      for (const conflict of exportValue.conflicts) {
        this.database.prepare(
          `INSERT INTO memory_conflicts (
            id, left_memory_id, left_revision, right_memory_id, right_revision, status,
            created_at, resolved_at, resolver_kind, resolver_id, resolution
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          conflict.id,
          conflict.leftMemoryId,
          conflict.leftRevision,
          conflict.rightMemoryId,
          conflict.rightRevision,
          conflict.status,
          conflict.createdAt,
          conflict.resolvedAt ?? null,
          conflict.resolver?.kind ?? null,
          conflict.resolver?.id ?? null,
          conflict.resolution ?? null,
        )
      }
      for (const retrieval of exportValue.retrievals) {
        this.database.prepare(
          `INSERT INTO memory_retrievals (
            id, query_hash, query_text, context_json, candidate_count, selected_json,
            token_budget, estimated_tokens, duration_ms, session_id, turn_number, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          retrieval.id,
          retrieval.queryHash,
          // Raw query text is an explicit diagnostic opt-in. A portable
          // export may come from an opt-in source, but importing it into a
          // default instance must not silently widen the retention policy.
          this.config.logQueryText ? retrieval.queryText ?? null : null,
          JSON.stringify(retrieval.context),
          retrieval.candidateCount,
          JSON.stringify(retrieval.selected),
          retrieval.tokenBudget,
          retrieval.estimatedTokens,
          retrieval.durationMs,
          retrieval.sessionId ?? null,
          retrieval.turn ?? null,
          retrieval.createdAt,
        )
      }
      for (const feedback of exportValue.feedback) {
        this.database.prepare(
          `INSERT INTO memory_feedback (
            id, memory_id, revision, retrieval_id, kind, actor_kind, actor_id, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          feedback.id,
          feedback.memoryId,
          feedback.revision,
          feedback.retrievalId ?? null,
          feedback.kind,
          feedback.actor.kind,
          feedback.actor.id,
          feedback.note ?? null,
          feedback.createdAt,
        )
      }
      for (const audit of exportValue.audit) {
        this.database.prepare(
          `INSERT INTO memory_audit (
            seq, created_at, actor_kind, actor_id, action, entity_type, entity_id, details_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          audit.seq,
          audit.createdAt,
          audit.actor.kind,
          audit.actor.id,
          audit.action,
          audit.entityType,
          audit.entityId,
          JSON.stringify(audit.details),
        )
      }
      for (const record of records) {
        if (record.status === 'active') this.upsertFts(record)
      }
      this.audit({ kind: 'migration', id: 'portable-restore' }, 'restore.export', 'store', 'canonical', {
        records: records.length,
        revisions: exportValue.revisions.length,
        candidates: exportValue.candidates.length,
        conflicts: exportValue.conflicts.length,
        retrievals: exportValue.retrievals.length,
        feedback: exportValue.feedback.length,
        audit: exportValue.audit.length,
        ...(feedbackProvided ? {} : { feedbackCountersReset: true }),
      }, exportValue.exportedAt)
    })
  }

  private insertExportRecord(record: MemoryRecord): void {
    this.database.prepare(
      `INSERT INTO memory_records (
        id, kind, scope_type, scope_key, status, current_revision, subject,
        applicability, action_text, rationale, confidence, sensitivity, owner,
        expires_at, content_hash, created_at, updated_at, positive_feedback,
        negative_feedback, use_count, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.memoryId, record.kind, record.scope.type, record.scope.key, record.status,
      record.revision, record.subject, record.applicability, record.action, record.rationale,
      record.confidence, record.sensitivity, record.owner, record.expiresAt ?? null,
      record.contentHash, record.createdAt, record.updatedAt, record.positiveFeedback,
      record.negativeFeedback, record.useCount, record.lastUsedAt ?? null,
    )
  }

  private insertExportRevision(revision: MemoryRevision): void {
    this.database.prepare(
      `INSERT INTO memory_revisions (
        memory_id, revision, parent_revision, operation, actor_kind, actor_id,
        kind, scope_type, scope_key, status, subject, applicability, action_text,
        rationale, confidence, sensitivity, owner, expires_at, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revision.memoryId, revision.revision, revision.parentRevision ?? null, revision.operation,
      revision.actor.kind, revision.actor.id, revision.kind, revision.scope.type, revision.scope.key,
      revision.status, revision.subject, revision.applicability, revision.action, revision.rationale,
      revision.confidence, revision.sensitivity, revision.owner, revision.expiresAt ?? null,
      revision.contentHash, revision.createdAt,
    )
    const evidence = this.database.prepare(
      `INSERT INTO memory_evidence (
        memory_id, revision, ordinal, kind, locator, note, observed_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const [ordinal, item] of revision.evidence.entries()) {
      evidence.run(
        revision.memoryId, revision.revision, ordinal, item.kind, item.locator,
        item.note ?? null, item.observedAt ?? null, item.contentHash ?? null,
      )
    }
  }

  rebuildFts(): void {
    this.assertWritable('rebuild-index')
    this.transaction(() => {
      this.database.exec('DELETE FROM memory_fts')
      for (const record of this.listRecords(['active'])) this.upsertFts(record)
      this.audit({ kind: 'system', id: 'index-rebuild' }, 'index.rebuild', 'store', 'memory_fts', {
        activeRecords: this.listRecords(['active']).length,
      }, Date.now())
    })
  }

  quickCheck(): 'ok' | 'failed' {
    const row = this.firstRow('PRAGMA quick_check')
    if (row === undefined) return 'failed'
    const value = Object.values(row)[0]
    return value === 'ok' ? 'ok' : 'failed'
  }

  /** Validate application-level invariants before exposing an existing store. */
  private validateCanonicalState(): void {
    const records = this.listRecords(['active', 'conflicted', 'stale', 'archived', 'deleted'])
    const recordIds = new Set(records.map(record => record.memoryId))
    const revisions = this.listRevisions()
    const revisionKeys = new Set(revisions.map(revision => revisionKey(revision.memoryId, revision.revision)))
    const conflicts = [...this.listConflicts('open'), ...this.listConflicts('resolved')]
    validateRevisionHistory(revisions, recordIds, 'integrity')
    validateConflictState(conflicts, records, revisions, 'integrity')

    const candidates = [
      ...this.listCandidates('candidate'),
      ...this.listCandidates('published'),
      ...this.listCandidates('rejected'),
      ...this.listCandidates('skipped'),
    ]
    validateCandidateReferences(candidates, records, revisions, conflicts, 'integrity')

    for (const conflict of conflicts) {
      if (!recordIds.has(conflict.leftMemoryId) || !recordIds.has(conflict.rightMemoryId)) {
        throw new Error(`dsh-memory integrity: conflict ${conflict.id} references missing memory`)
      }
      if (!revisionKeys.has(revisionKey(conflict.leftMemoryId, conflict.leftRevision))
        || !revisionKeys.has(revisionKey(conflict.rightMemoryId, conflict.rightRevision))) {
        throw new Error(`dsh-memory integrity: conflict ${conflict.id} references missing revision`)
      }
      if (conflict.status === 'open') {
        const left = records.find(record => record.memoryId === conflict.leftMemoryId)
        const right = records.find(record => record.memoryId === conflict.rightMemoryId)
        if (left?.status !== 'conflicted' || right?.status !== 'conflicted'
          || left.revision !== conflict.leftRevision || right.revision !== conflict.rightRevision) {
          throw new Error(`dsh-memory integrity: open conflict ${conflict.id} is not current on both records`)
        }
      }
    }

    const retrievals = this.listRetrievals()
    const retrievalIds = new Set(retrievals.map(retrieval => retrieval.id))
    for (const retrieval of retrievals) {
      for (const selected of retrieval.selected) {
        if (!recordIds.has(selected.memoryId) || !revisionKeys.has(revisionKey(selected.memoryId, selected.revision))) {
          throw new Error(`dsh-memory integrity: retrieval ${retrieval.id} references missing revision`)
        }
      }
    }
    validateRetrievalReferences(retrievals, records, revisions, 'integrity')

    const feedback = this.listFeedback()
    for (const item of feedback) {
      if (!recordIds.has(item.memoryId) || !revisionKeys.has(revisionKey(item.memoryId, item.revision))) {
        throw new Error(`dsh-memory integrity: feedback ${item.id} references missing revision`)
      }
      if (item.retrievalId !== undefined) {
        const retrieval = retrievals.find(value => value.id === item.retrievalId)
        if (!retrievalIds.has(item.retrievalId) || !retrieval?.selected.some(selected =>
          selected.memoryId === item.memoryId && selected.revision === item.revision)) {
          throw new Error(`dsh-memory integrity: feedback ${item.id} has an invalid retrieval reference`)
        }
      }
    }
    validateFeedbackCounters(records, feedback, 'integrity')

    let previousAuditSeq = 0
    for (const audit of this.listAudit()) {
      if (audit.seq <= previousAuditSeq) throw new Error('dsh-memory integrity: audit sequence is not strictly increasing')
      previousAuditSeq = audit.seq
    }
    this.ensureFtsIndex(records)
  }

  /** Repair a derived FTS index from canonical record heads, or fail read-only. */
  private ensureFtsIndex(records: readonly MemoryRecord[]): void {
    const mismatch = this.firstRow(
      `SELECT COUNT(*) AS count FROM (
         SELECT r.id
         FROM memory_records r
         LEFT JOIN memory_fts f ON f.memory_id = r.id
         WHERE r.status = 'active'
           AND (f.memory_id IS NULL OR f.subject IS NOT r.subject
             OR f.applicability IS NOT r.applicability
             OR f.action_text IS NOT r.action_text
             OR f.rationale IS NOT r.rationale)
         UNION ALL
         SELECT f.memory_id
         FROM memory_fts f
         LEFT JOIN memory_records r ON r.id = f.memory_id
         WHERE r.id IS NULL OR r.status <> 'active'
           OR f.subject IS NOT r.subject
           OR f.applicability IS NOT r.applicability
           OR f.action_text IS NOT r.action_text
           OR f.rationale IS NOT r.rationale
         UNION ALL
         SELECT f.memory_id
         FROM memory_fts f
         GROUP BY f.memory_id
         HAVING COUNT(*) <> 1
       ) AS mismatches`,
    )
    const mismatchCount = mismatch === undefined ? 0 : readNumber(mismatch, 'count')
    if (mismatchCount === 0) return
    if (this.config.readOnly) {
      throw new Error('dsh-memory integrity: derived full-text index is inconsistent and the store is read-only')
    }
    this.transaction(() => {
      this.database.exec('DELETE FROM memory_fts')
      for (const record of records.filter(value => value.status === 'active')) this.upsertFts(record)
      this.audit({ kind: 'system', id: 'index-repair' }, 'index.rebuild', 'store', 'memory_fts', {
        repairedEntries: records.filter(value => value.status === 'active').length,
      }, Date.now())
    })
  }

  private configure(): void {
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;')
    if (!this.config.readOnly) {
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const current = readPragmaVersion(this.database)
      if (current === 0) {
        assertFreshDatabase(this.database)
        this.transaction(() => {
          this.database.exec(CREATE_SCHEMA_SQL)
          this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)
        })
      } else if (current > STORE_SCHEMA_VERSION) {
        throw new Error(
          `dsh-memory schema: store version ${current} is newer than supported ${STORE_SCHEMA_VERSION}`,
        )
      } else if (current < STORE_SCHEMA_VERSION) {
        this.migrateSchema(current)
      }
      assertSchemaShape(this.database)
    } else {
      const current = readPragmaVersion(this.database)
      if (current !== STORE_SCHEMA_VERSION) {
        throw new Error(
          `dsh-memory schema: read-only store version ${current} does not match ${STORE_SCHEMA_VERSION}`,
        )
      }
      assertSchemaShape(this.database)
    }
  }

  /** Apply only known forward migrations while holding the writer lock. */
  private migrateSchema(current: number): void {
    let version = current
    while (version < STORE_SCHEMA_VERSION) {
      if (version === 1) {
        this.transaction(() => {
          this.database.exec(MIGRATE_V1_TO_V2_SQL)
          this.database.exec('PRAGMA user_version = 2')
          this.audit({ kind: 'migration', id: 'schema-v1-to-v2' }, 'schema.migrate', 'store', 'canonical', {
            from: 1,
            to: 2,
          }, Date.now())
        })
        version = 2
        continue
      }
      throw new Error(`dsh-memory schema: no migration from ${version} to ${STORE_SCHEMA_VERSION}`)
    }
  }

  private findSimilarMemoryIds(
    content: MemoryContent,
    excludedId: string | undefined,
    maxSensitivity: MemorySensitivity,
  ): string[] {
    if (this.config.maxNearDuplicateSuggestions === 0) return []
    const query = toFtsQuery(`${content.subject}\n${content.applicability}\n${content.action}`)
    if (query.length === 0) return []
    const rows = this.rows(
      `SELECT r.id, r.subject, r.applicability, r.action_text FROM memory_fts
       JOIN memory_records r ON r.id = memory_fts.memory_id
       WHERE memory_fts MATCH ?
          AND r.kind = ? AND r.scope_type = ? AND r.scope_key = ?
          AND CASE r.sensitivity WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END <= ?
          AND r.status IN ('active', 'conflicted', 'stale', 'archived')
         AND (? IS NULL OR r.id <> ?)
       ORDER BY bm25(memory_fts, 8.0, 3.0, 5.0, 1.0), r.id
       LIMIT 100`,
      query,
      content.kind,
      content.scope.type,
      content.scope.key,
      SENSITIVITY_LEVEL[maxSensitivity],
      excludedId ?? null,
      excludedId ?? null,
    )
    const left = similarityTokens(content)
    return rows.map(row => {
      // Near-duplicate hints only need the indexed lexical fields. Avoid
      // decoding full revision/evidence graphs for every proposal; canonical
      // integrity is checked at open and references are checked during export
      // and the next integrity pass.
      const id = normalizeIdentifier(readString(row, 'id'), 'similarMemoryId')
      const comparable = {
        subject: storedText(readString(row, 'subject'), 'similar.subject', 300),
        applicability: storedText(readString(row, 'applicability'), 'similar.applicability', 2_000),
        action: storedText(readString(row, 'action_text'), 'similar.action', 4_000),
      }
      return { id, score: jaccard(left, similarityTokens(comparable)) }
    }).filter(item => item.score >= this.config.nearDuplicateThreshold)
      .sort((leftItem, rightItem) => rightItem.score - leftItem.score || leftItem.id.localeCompare(rightItem.id))
      .slice(0, this.config.maxNearDuplicateSuggestions)
      .map(item => item.id)
  }

  private publishCandidate(candidate: MemoryCandidate, reviewer: MemoryActor, now: number): MemoryRecord {
    if (candidate.content.expiresAt !== undefined && candidate.content.expiresAt <= now) {
      throw new Error(`dsh-memory publish: candidate ${candidate.id} expired before review`)
    }
    const duplicate = this.firstRow(
      `SELECT id FROM memory_records
       WHERE content_hash = ? AND kind = ? AND scope_type = ? AND scope_key = ?
         AND status IN ('active', 'conflicted', 'stale', 'archived')
       ORDER BY updated_at DESC, id LIMIT 1`,
      candidate.contentHash,
      candidate.content.kind,
      candidate.content.scope.type,
      candidate.content.scope.key,
    )
    if (duplicate !== undefined) {
      throw new Error(
        `dsh-memory publish: candidate ${candidate.id} became an exact duplicate of ${readString(duplicate, 'id')}; review it as skip`,
      )
    }
    if (candidate.operation === 'create') {
      const id = randomUUID()
      const revision = this.insertRevision(id, 1, undefined, 'create', reviewer, candidate.content, 'active', now, true)
      this.insertRecordHead(revision, 'active', now)
      this.upsertFts(revision)
      return this.requireRecordUnscoped(id)
    }

    const targetId = candidate.targetMemoryId
    const expected = candidate.expectedRevision
    if (targetId === undefined || expected === undefined) {
      throw new Error(`dsh-memory publish: ${candidate.operation} candidate is missing a target revision`)
    }
    const target = this.requireRecordUnscoped(targetId)
    if (target.revision !== expected) {
      throw new Error(
        `dsh-memory publish: optimistic revision mismatch for ${targetId} `
        + `(expected ${expected}, current ${target.revision})`,
      )
    }
    if (target.status === 'deleted') throw new Error(`dsh-memory publish: target ${targetId} is deleted`)
    if (target.status === 'conflicted') {
      throw new Error(`dsh-memory publish: target ${targetId} is conflicted; resolve the conflict first`)
    }
    assertTargetCompatibility(candidate.operation, candidate.content, target, 'publish')

    if (candidate.operation === 'update') {
      const revision = this.insertRevision(
        targetId,
        expected + 1,
        expected,
        'update',
        reviewer,
        candidate.content,
        'active',
        now,
      )
      this.updateRecordHead(revision, 'active', target)
      this.upsertFts(revision)
      return this.requireRecordUnscoped(targetId)
    }

    // Version both sides of a contradiction. The left record's status change
    // must be represented by an immutable revision as well; otherwise its
    // current head would claim a conflict while its revision history skipped
    // the event entirely.
    const leftRevision = this.insertRevision(
      targetId,
      target.revision + 1,
      target.revision,
      'contradict',
      reviewer,
      target,
      'conflicted',
      now,
    )
    this.updateRecordHead(leftRevision, 'conflicted', target)
    this.removeFts(targetId)

    const rightId = randomUUID()
    const rightRevision = this.insertRevision(
      rightId,
      1,
      undefined,
      'contradict',
      reviewer,
      candidate.content,
      'conflicted',
      now,
      true,
    )
    this.insertRecordHead(rightRevision, 'conflicted', now)
    this.removeFts(rightId)
    const conflictId = randomUUID()
    this.database.prepare(
      `INSERT INTO memory_conflicts (
        id, left_memory_id, left_revision, right_memory_id, right_revision, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    ).run(conflictId, targetId, leftRevision.revision, rightId, rightRevision.revision, now)
    this.audit(reviewer, 'conflict.open', 'conflict', conflictId, {
      leftMemoryId: targetId,
      leftRevision: leftRevision.revision,
      rightMemoryId: rightId,
      rightRevision: rightRevision.revision,
    }, now)
    return this.requireRecordUnscoped(rightId)
  }

  private validateProposalTarget(
    operation: MemoryCandidateOperation,
    targetMemoryId: string | undefined,
    expectedRevision: number | undefined,
  ): { id: string; revision: number; record: MemoryRecord } | undefined {
    if (operation === 'create') {
      if (targetMemoryId !== undefined || expectedRevision !== undefined) {
        throw new Error('dsh-memory propose: create must not specify a target')
      }
      return undefined
    }
    if (targetMemoryId === undefined || expectedRevision === undefined) {
      throw new Error(`dsh-memory propose: ${operation} requires targetMemoryId and expectedRevision`)
    }
    const id = normalizeIdentifier(targetMemoryId, 'targetMemoryId')
    const revision = assertPositiveInteger(expectedRevision, 'expectedRevision')
    const target = this.requireRecordUnscoped(id)
    if (target.revision !== revision) {
      throw new Error(
        `dsh-memory propose: optimistic revision mismatch for ${id} `
        + `(expected ${revision}, current ${target.revision})`,
      )
    }
    if (target.status === 'conflicted') {
      throw new Error(`dsh-memory propose: target ${id} is conflicted; resolve the conflict first`)
    }
    return { id, revision, record: target }
  }

  private insertRecordHead(revision: MemoryRevision, status: MemoryStatus, now: number): void {
    this.database.prepare(
      `INSERT INTO memory_records (
        id, kind, scope_type, scope_key, status, current_revision, subject,
        applicability, action_text, rationale, confidence, sensitivity, owner,
        expires_at, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revision.memoryId,
      revision.kind,
      revision.scope.type,
      revision.scope.key,
      status,
      revision.revision,
      revision.subject,
      revision.applicability,
      revision.action,
      revision.rationale,
      revision.confidence,
      revision.sensitivity,
      revision.owner,
      revision.expiresAt ?? null,
      revision.contentHash,
      now,
      now,
    )
  }

  private updateRecordHead(
    revision: MemoryRevision,
    status: MemoryStatus,
    previous: MemoryRecord,
  ): void {
    if (revision.parentRevision === undefined) {
      throw new Error('dsh-memory update: a record-head update requires parentRevision')
    }
    const result = this.database.prepare(
      `UPDATE memory_records SET
        kind = ?, scope_type = ?, scope_key = ?, status = ?, current_revision = ?,
        subject = ?, applicability = ?, action_text = ?, rationale = ?, confidence = ?,
        sensitivity = ?, owner = ?, expires_at = ?, content_hash = ?, updated_at = ?,
        positive_feedback = ?, negative_feedback = ?, use_count = ?, last_used_at = ?
       WHERE id = ? AND current_revision = ?`,
    ).run(
      revision.kind,
      revision.scope.type,
      revision.scope.key,
      status,
      revision.revision,
      revision.subject,
      revision.applicability,
      revision.action,
      revision.rationale,
      revision.confidence,
      revision.sensitivity,
      revision.owner,
      revision.expiresAt ?? null,
      revision.contentHash,
      revision.createdAt,
      previous.positiveFeedback,
      previous.negativeFeedback,
      previous.useCount,
      previous.lastUsedAt ?? null,
      revision.memoryId,
      revision.parentRevision,
    )
    if (mutationCount(result) !== 1) {
      throw new Error(`dsh-memory update: record head changed concurrently for ${revision.memoryId}`)
    }
  }

  private insertRevision(
    memoryId: string,
    revision: number,
    parentRevision: number | undefined,
    operation: MemoryRevisionOperation,
    actor: MemoryActor,
    content: MemoryContent,
    status: MemoryStatus,
    now: number,
    deferredForeignKey = false,
  ): MemoryRevision {
    if (deferredForeignKey) this.database.exec('PRAGMA defer_foreign_keys = ON')
    if (parentRevision !== undefined) {
      const parentRow = this.firstRow(
        'SELECT created_at FROM memory_revisions WHERE memory_id = ? AND revision = ?',
        memoryId,
        parentRevision,
      )
      if (parentRow === undefined) throw new Error(`dsh-memory ${operation}: missing parent revision ${memoryId}@${parentRevision}`)
      const parentCreatedAt = normalizeNow(readNumber(parentRow, 'created_at'))
      if (now < parentCreatedAt) {
        throw new Error(`dsh-memory ${operation}: revision timestamp cannot move backwards for ${memoryId}`)
      }
    }
    const hash = contentHash(content)
    this.database.prepare(
      `INSERT INTO memory_revisions (
        memory_id, revision, parent_revision, operation, actor_kind, actor_id,
        kind, scope_type, scope_key, status, subject, applicability, action_text,
        rationale, confidence, sensitivity, owner, expires_at, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      memoryId,
      revision,
      parentRevision ?? null,
      operation,
      actor.kind,
      actor.id,
      content.kind,
      content.scope.type,
      content.scope.key,
      status,
      content.subject,
      content.applicability,
      content.action,
      content.rationale,
      content.confidence,
      content.sensitivity,
      content.owner,
      content.expiresAt ?? null,
      hash,
      now,
    )
    const insertEvidence = this.database.prepare(
      `INSERT INTO memory_evidence (
        memory_id, revision, ordinal, kind, locator, note, observed_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const [ordinal, evidence] of content.evidence.entries()) {
      insertEvidence.run(
        memoryId,
        revision,
        ordinal,
        evidence.kind,
        evidence.locator,
        evidence.note ?? null,
        evidence.observedAt ?? null,
        evidence.contentHash ?? null,
      )
    }
    return Object.freeze({
      ...content,
      memoryId,
      revision,
      ...(parentRevision === undefined ? {} : { parentRevision }),
      operation,
      status,
      actor,
      contentHash: hash,
      createdAt: now,
    })
  }

  private recordUnscoped(id: string, includeEvidence: boolean): MemoryRecord | undefined {
    const row = this.firstRow('SELECT * FROM memory_records WHERE id = ?', id)
    return row === undefined ? undefined : this.decodeRecordRow(row, includeEvidence)
  }

  private requireRecordUnscoped(id: string): MemoryRecord {
    const record = this.recordUnscoped(id, true)
    if (record === undefined) throw new Error(`dsh-memory: unknown memory ${id}`)
    return record
  }

  private requireCandidate(id: string): MemoryCandidate {
    const candidate = this.getCandidate(id)
    if (candidate === undefined) throw new Error(`dsh-memory: unknown candidate ${id}`)
    return candidate
  }

  private candidateByRequestId(requestId: string): MemoryCandidate | undefined {
    const row = this.firstRow('SELECT * FROM memory_candidates WHERE request_id = ?', requestId)
    return row === undefined ? undefined : this.decodeCandidateRow(row)
  }

  private decodeRecordRow(row: SqlRow, includeEvidence: boolean, context?: RecordDecodeContext): MemoryRecord {
    const memoryId = normalizeIdentifier(readString(row, 'id'), 'record.memoryId')
    const revision = assertPositiveInteger(readNumber(row, 'current_revision'), 'record.revision')
    const revisionRow = context?.revisionRow ?? this.firstRow(
      'SELECT * FROM memory_revisions WHERE memory_id = ? AND revision = ?', memoryId, revision,
    )
    if (revisionRow === undefined) throw new Error(`dsh-memory decode: missing revision ${memoryId}@${revision}`)
    const base = this.decodeRevisionRow(revisionRow, includeEvidence, context === undefined ? undefined : {
      evidenceRows: context.evidenceRows,
      ...(context.parentRow === undefined ? {} : { parentRow: context.parentRow }),
    })
    const status = readStatus(row)
    const updatedAt = normalizeNow(readNumber(row, 'updated_at'))
    assertRecordHeadMatchesRevision(row, base, status, updatedAt)
    const firstRevisionRow = context?.firstRevisionRow ?? this.firstRow(
      'SELECT created_at FROM memory_revisions WHERE memory_id = ? AND revision = 1',
      memoryId,
    )
    if (firstRevisionRow === undefined) throw new Error(`dsh-memory decode: missing first revision ${memoryId}`)
    const createdAt = normalizeNow(readNumber(row, 'created_at'))
    if (createdAt !== normalizeNow(readNumber(firstRevisionRow, 'created_at'))) {
      throw new Error(`dsh-memory decode: record creation timestamp disagrees with revision history ${memoryId}`)
    }
    if (updatedAt < createdAt) {
      throw new Error(`dsh-memory decode: record updated_at precedes creation ${memoryId}`)
    }
    const latestRow = context === undefined
      ? this.firstRow('SELECT MAX(revision) AS revision FROM memory_revisions WHERE memory_id = ?', memoryId)
      : undefined
    if (context === undefined && latestRow === undefined) {
      throw new Error(`dsh-memory decode: missing latest revision ${memoryId}`)
    }
    const latestRevision = context?.latestRevision ?? readNumber(latestRow!, 'revision')
    if (latestRevision !== revision) {
      throw new Error(`dsh-memory decode: record head is not the latest revision ${memoryId}@${revision}`)
    }
    const lastUsedAt = readOptionalNumber(row, 'last_used_at')
    if (lastUsedAt !== undefined && normalizeNow(lastUsedAt) < createdAt) {
      throw new Error(`dsh-memory decode: record last_used_at precedes creation ${memoryId}`)
    }
    return Object.freeze({
      ...base,
      status,
      // `memory_records.created_at` is the immutable birth time of the
      // logical record; the revision head's timestamp belongs to `updatedAt`.
      createdAt,
      updatedAt,
      positiveFeedback: assertNonNegativeInteger(readNumber(row, 'positive_feedback'), 'record.positiveFeedback'),
      negativeFeedback: assertNonNegativeInteger(readNumber(row, 'negative_feedback'), 'record.negativeFeedback'),
      useCount: assertNonNegativeInteger(readNumber(row, 'use_count'), 'record.useCount'),
      ...(lastUsedAt === undefined ? {} : { lastUsedAt: normalizeNow(lastUsedAt) }),
    })
  }

  private decodeRevisionRow(row: SqlRow, includeEvidence: boolean, context?: RevisionDecodeContext): MemoryRevision {
    const memoryId = normalizeIdentifier(readString(row, 'memory_id'), 'revision.memoryId')
    const revision = assertPositiveInteger(readNumber(row, 'revision'), 'revision.revision')
    const createdAt = normalizeNow(readNumber(row, 'created_at'))
    const parentRevision = readOptionalNumber(row, 'parent_revision')
    let parentRow: SqlRow | undefined
    if (parentRevision !== undefined) {
      if (revision === 1 || !Number.isSafeInteger(parentRevision) || parentRevision !== revision - 1) {
        throw new Error(`dsh-memory decode: invalid parent revision ${memoryId}@${revision}`)
      }
      parentRow = context?.parentRow ?? this.firstRow(
        `SELECT revision, operation, status, actor_kind, actor_id, kind, scope_type,
           scope_key, sensitivity, content_hash, created_at
         FROM memory_revisions WHERE memory_id = ? AND revision = ?`, memoryId, parentRevision,
      )
      if (parentRow === undefined) throw new Error(`dsh-memory decode: missing parent revision ${memoryId}@${parentRevision}`)
      const parentCreatedAt = normalizeNow(readNumber(parentRow, 'created_at'))
      if (createdAt < parentCreatedAt) {
        throw new Error(`dsh-memory decode: revision timestamp moves backwards ${memoryId}@${revision}`)
      }
    } else if (revision !== 1) {
      throw new Error(`dsh-memory decode: missing parent revision ${memoryId}@${revision}`)
    }
    const operation = readString(row, 'operation') as MemoryRevisionOperation
    assertRevisionOperation(operation)
    const status = readString(row, 'status') as MemoryStatus
    assertRecordStatus(status)
    const actor = normalizeActor({
      kind: readString(row, 'actor_kind') as MemoryActor['kind'],
      id: readString(row, 'actor_id'),
    })
    const kind = readString(row, 'kind') as MemoryKind
    assertMemoryKind(kind)
    const scope = normalizeScope({
      type: readString(row, 'scope_type') as MemoryScopeType,
      key: readString(row, 'scope_key'),
    })
    const subject = storedText(readString(row, 'subject'), 'revision.subject', 300)
    const applicability = storedText(readString(row, 'applicability'), 'revision.applicability', 2_000)
    const action = storedText(readString(row, 'action_text'), 'revision.action', 4_000)
    const rationale = storedText(readString(row, 'rationale'), 'revision.rationale', 4_000)
    const confidence = readNumber(row, 'confidence')
    if (confidence < 0 || confidence > 1) throw new Error(`dsh-memory decode: revision.confidence is outside [0, 1]`)
    const sensitivity = readString(row, 'sensitivity') as MemorySensitivity
    assertSensitivity(sensitivity)
    const owner = storedText(readString(row, 'owner'), 'revision.owner', 200)
    const expiresAtValue = readOptionalNumber(row, 'expires_at')
    const expiresAt = expiresAtValue === undefined ? undefined : normalizeNow(expiresAtValue)
    if (revision === 1 && kind === 'working' && (expiresAt === undefined || expiresAt <= createdAt)) {
      throw new Error(`dsh-memory decode: first working revision must expire after creation ${memoryId}`)
    }
    const allEvidence = context === undefined
      ? this.readEvidence(memoryId, revision)
      : this.decodeEvidenceRows(context.evidenceRows, memoryId, revision)
    if (allEvidence.length === 0 || allEvidence.length > 50) {
      throw new Error(`dsh-memory decode: revision ${memoryId}@${revision} must contain 1 to 50 evidence references`)
    }
    const content: MemoryContent = Object.freeze({
      kind,
      scope,
      subject,
      applicability,
      action,
      rationale,
      confidence,
      sensitivity,
      owner,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      evidence: Object.freeze(allEvidence),
    })
    const encoded = JSON.stringify(content)
    if (containsSecret(encoded) || containsPrivateContext(encoded)) {
      throw new Error(`dsh-memory decode: revision ${memoryId}@${revision} contains sensitive content`)
    }
    const storedHash = normalizeSha256(readString(row, 'content_hash'), 'revision.contentHash')
    if (contentHash(content) !== storedHash) {
      throw new Error(`dsh-memory decode: revision content hash mismatch ${memoryId}@${revision}`)
    }
    const decoded = Object.freeze({
      memoryId,
      revision,
      ...(parentRevision === undefined ? {} : { parentRevision }),
      operation,
      status,
      actor,
      ...content,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      evidence: Object.freeze(includeEvidence ? allEvidence : []),
      contentHash: storedHash,
      createdAt,
    })
    if (parentRow !== undefined) assertRevisionParentSemantics(decoded, parentRow)
    assertRevisionSemantics(decoded)
    return decoded
  }

  private decodeCandidateRow(row: SqlRow): MemoryCandidate {
    const contentValue: unknown = parseJson(readString(row, 'content_json'), 'candidate content')
    const createdAt = normalizeNow(readNumber(row, 'created_at'))
    const content = normalizeContent(contentValue as MemoryContent, {
      now: createdAt,
      maxChars: this.config.maxCandidateChars,
      maxWorkingTtlHours: this.config.maxWorkingTtlHours,
      secretPolicy: 'reject',
    })
    const candidateId = normalizeIdentifier(readString(row, 'id'), 'candidate.id')
    const storedHash = normalizeSha256(readString(row, 'content_hash'), 'candidate.contentHash')
    if (contentHash(content) !== storedHash) {
      throw new Error(`dsh-memory decode: candidate content hash mismatch ${candidateId}`)
    }
    const actor = normalizeActor({
      kind: readString(row, 'actor_kind') as MemoryActor['kind'],
      id: readString(row, 'actor_id'),
    })
    const reviewerKind = readOptionalString(row, 'reviewer_kind')
    const reviewerId = readOptionalString(row, 'reviewer_id')
    const reviewer = reviewerKind === undefined || reviewerId === undefined
      ? undefined
      : normalizeActor({ kind: reviewerKind as MemoryActor['kind'], id: reviewerId })
    const targetValue = readOptionalString(row, 'target_memory_id')
    const targetMemoryId = targetValue === undefined ? undefined : normalizeIdentifier(targetValue, 'candidate.targetMemoryId')
    const expectedValue = readOptionalNumber(row, 'expected_revision')
    const expectedRevision = expectedValue === undefined ? undefined : assertPositiveInteger(expectedValue, 'candidate.expectedRevision')
    const exactValue = readOptionalString(row, 'exact_duplicate_id')
    const exactDuplicateId = exactValue === undefined ? undefined : normalizeIdentifier(exactValue, 'candidate.exactDuplicateId')
    const similarMemoryIds = decodeIdentifierArray(
      parseJson(readString(row, 'similar_memory_ids_json'), 'candidate similar memory ids'),
      'candidate.similarMemoryIds',
    )
    const requestValue = readOptionalString(row, 'request_id')
    const requestId = requestValue === undefined ? undefined : normalizeIdentifier(requestValue, 'candidate.requestId')
    const publishedValue = readOptionalString(row, 'published_memory_id')
    const publishedMemoryId = publishedValue === undefined ? undefined : normalizeIdentifier(publishedValue, 'candidate.publishedMemoryId')
    const reviewedValue = readOptionalNumber(row, 'reviewed_at')
    const reviewedAt = reviewedValue === undefined ? undefined : normalizeNow(reviewedValue)
    const decisionValue = readOptionalString(row, 'decision_reason')
    const decisionReason = decisionValue === undefined
      ? undefined
      : normalizeStoredReason(decisionValue, `candidate ${candidateId} decision reason`)
    const operation = readString(row, 'operation') as MemoryCandidateOperation
    assertCandidateOperation(operation)
    const status = readString(row, 'status') as MemoryCandidateStatus
    assertCandidateStatus(status)
    const candidate: MemoryCandidate = Object.freeze({
      id: candidateId,
      ...(requestId === undefined ? {} : { requestId }),
      operation,
      status,
      content,
      actor,
      ...(targetMemoryId === undefined ? {} : { targetMemoryId }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(exactDuplicateId === undefined ? {} : { exactDuplicateId }),
      similarMemoryIds: Object.freeze(similarMemoryIds),
      contentHash: storedHash,
      createdAt,
      ...(reviewedAt === undefined ? {} : { reviewedAt }),
      ...(reviewer === undefined ? {} : { reviewer }),
      ...(decisionReason === undefined ? {} : { decisionReason }),
      ...(publishedMemoryId === undefined ? {} : { publishedMemoryId }),
    })
    validateCandidateState(candidate)
    return candidate
  }

  private decodeRetrievalRow(row: SqlRow): MemoryRetrievalLog {
    const queryText = readOptionalString(row, 'query_text')
    const queryHashValue = normalizeSha256(readString(row, 'query_hash'), 'retrieval.queryHash')
    const normalizedQueryText = queryText === undefined ? undefined : normalizeQuery(queryText)
    if (normalizedQueryText !== undefined
      && (containsSecret(normalizedQueryText) || containsPrivateContext(normalizedQueryText))) {
      throw new Error(`dsh-memory decode: retrieval query text contains sensitive content ${readString(row, 'id')}`)
    }
    if (normalizedQueryText !== undefined && queryHash(normalizedQueryText) !== queryHashValue) {
      throw new Error(`dsh-memory decode: retrieval query hash mismatch ${readString(row, 'id')}`)
    }
    const contextValue = parseJson(readString(row, 'context_json'), 'retrieval context')
    const selectedValue = parseJson(readString(row, 'selected_json'), 'retrieval selection')
    const candidateCount = assertNonNegativeInteger(readNumber(row, 'candidate_count'), 'retrieval.candidateCount')
    const selected = decodeSelectedReferences(selectedValue)
    if (selected.length > 100) throw new Error(`dsh-memory decode: retrieval selection is too large ${readString(row, 'id')}`)
    const tokenBudget = assertNonNegativeInteger(readNumber(row, 'token_budget'), 'retrieval.tokenBudget')
    const estimatedTokens = assertNonNegativeInteger(readNumber(row, 'estimated_tokens'), 'retrieval.estimatedTokens')
    if (selected.length > candidateCount) throw new Error(`dsh-memory decode: retrieval selection exceeds candidate count ${readString(row, 'id')}`)
    if (estimatedTokens > tokenBudget) throw new Error(`dsh-memory decode: retrieval exceeds token budget ${readString(row, 'id')}`)
    return Object.freeze({
      id: normalizeIdentifier(readString(row, 'id'), 'retrieval.id'),
      queryHash: queryHashValue,
      ...(normalizedQueryText === undefined ? {} : { queryText: normalizedQueryText }),
      context: normalizeAccessContext(contextValue as MemoryAccessContext),
      candidateCount,
      selected: Object.freeze(selected),
      tokenBudget,
      estimatedTokens,
      durationMs: assertNonNegative(readNumber(row, 'duration_ms'), 'retrieval.durationMs'),
      ...(readOptionalString(row, 'session_id') === undefined
        ? {}
        : { sessionId: normalizeIdentifier(readOptionalString(row, 'session_id')!, 'retrieval.sessionId') }),
      ...(readOptionalNumber(row, 'turn_number') === undefined
        ? {}
        : { turn: assertNonNegativeInteger(readOptionalNumber(row, 'turn_number')!, 'retrieval.turn') }),
      createdAt: normalizeNow(readNumber(row, 'created_at')),
    })
  }

  private decodeFeedbackRow(row: SqlRow): MemoryFeedbackRecord {
    const note = readOptionalString(row, 'note')
    const kind = readString(row, 'kind') as MemoryFeedbackKind
    assertFeedbackKind(kind)
    if (note !== undefined && containsSecret(note)) {
      throw new Error('dsh-memory decode: feedback note contains secret-like content')
    }
    const retrievalId = readOptionalString(row, 'retrieval_id')
    return Object.freeze({
      id: normalizeIdentifier(readString(row, 'id'), 'feedback.id'),
      memoryId: normalizeIdentifier(readString(row, 'memory_id'), 'feedback.memoryId'),
      revision: assertPositiveInteger(readNumber(row, 'revision'), 'feedback.revision'),
      ...(retrievalId === undefined ? {} : { retrievalId: normalizeIdentifier(retrievalId, 'feedback.retrievalId') }),
      kind,
      actor: normalizeActor({
        kind: readString(row, 'actor_kind') as MemoryActor['kind'],
        id: readString(row, 'actor_id'),
      }),
      ...(note === undefined ? {} : { note: normalizeOptionalNote(note) }),
      createdAt: normalizeNow(readNumber(row, 'created_at')),
    })
  }

  private decodeAuditRow(row: SqlRow): MemoryAuditRecord {
    const details = parseJson(readString(row, 'details_json'), 'audit details')
    if (typeof details !== 'object' || details === null || Array.isArray(details)) {
      throw new Error('dsh-memory decode: audit details must be an object')
    }
    const encoded = JSON.stringify(details)
    if (typeof encoded !== 'string' || containsSecret(encoded) || containsPrivateContext(encoded)) {
      throw new Error('dsh-memory decode: audit details contain sensitive content')
    }
    return Object.freeze({
      seq: assertPositiveInteger(readNumber(row, 'seq'), 'audit.seq'),
      createdAt: normalizeNow(readNumber(row, 'created_at')),
      actor: normalizeActor({
        kind: readString(row, 'actor_kind') as MemoryActor['kind'],
        id: readString(row, 'actor_id'),
      }),
      action: normalizeIdentifier(readString(row, 'action'), 'audit.action'),
      entityType: normalizeIdentifier(readString(row, 'entity_type'), 'audit.entityType'),
      entityId: normalizeIdentifier(readString(row, 'entity_id'), 'audit.entityId'),
      details: Object.freeze(details as Record<string, unknown>),
    })
  }

  private readEvidence(memoryId: string, revision: number): EvidenceReference[] {
    const rows = this.rows(
      `SELECT * FROM memory_evidence WHERE memory_id = ? AND revision = ? ORDER BY ordinal`,
      memoryId,
      revision,
    )
    return this.decodeEvidenceRows(rows, memoryId, revision)
  }

  private decodeEvidenceRows(rows: readonly SqlRow[], memoryId: string, revision: number): EvidenceReference[] {
    if (rows.length > 50) {
      throw new Error(`dsh-memory decode: too many evidence references for ${memoryId}@${revision}`)
    }
    return rows.map((row, index) => {
      const ordinal = assertNonNegativeInteger(readNumber(row, 'ordinal'), 'evidence.ordinal')
      if (ordinal !== index) throw new Error(`dsh-memory decode: evidence ordinals are not contiguous for ${memoryId}@${revision}`)
      const kind = readString(row, 'kind') as EvidenceReference['kind']
      assertEvidenceKind(kind)
      const locator = storedText(readString(row, 'locator'), 'evidence.locator', 2_000)
      const noteValue = readOptionalString(row, 'note')
      const note = noteValue === undefined ? undefined : storedText(noteValue, 'evidence.note', 1_000)
      const observedValue = readOptionalNumber(row, 'observed_at')
      const observedAt = observedValue === undefined ? undefined : normalizeNow(observedValue)
      const hashValue = readOptionalString(row, 'content_hash')
      const hash = hashValue === undefined ? undefined : normalizeSha256(hashValue, 'evidence.contentHash')
      return Object.freeze({
        kind,
        locator,
        ...(note === undefined ? {} : { note }),
        ...(observedAt === undefined ? {} : { observedAt }),
        ...(hash === undefined ? {} : { contentHash: hash }),
      })
    })
  }

  private upsertFts(content: Pick<MemoryRevision, 'memoryId' | 'subject' | 'applicability' | 'action' | 'rationale'>): void {
    this.removeFts(content.memoryId)
    this.database.prepare(
      'INSERT INTO memory_fts(memory_id, subject, applicability, action_text, rationale) VALUES (?, ?, ?, ?, ?)',
    ).run(content.memoryId, content.subject, content.applicability, content.action, content.rationale)
  }

  private removeFts(memoryId: string): void {
    this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId)
  }

  private audit(
    actor: MemoryActor,
    action: string,
    entityType: string,
    entityId: string,
    details: Readonly<Record<string, unknown>>,
    now: number,
  ): void {
    const encoded = JSON.stringify(details, (_key, value: unknown) => typeof value === 'string' ? redactSecrets(value) : value)
    if (typeof encoded !== 'string') throw new Error('dsh-memory audit: details must be JSON-serializable')
    if (encoded.length > 16_000) {
      throw new Error('dsh-memory audit: details exceed the 16000-character limit')
    }
    if (containsSecret(encoded)) {
      throw new Error('dsh-memory audit: details contain secret-like content')
    }
    if (containsPrivateContext(encoded)) {
      throw new Error('dsh-memory audit: details contain private transcript content')
    }
    this.database.prepare(
      `INSERT INTO memory_audit (
        created_at, actor_kind, actor_id, action, entity_type, entity_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, actor.kind, actor.id, action, entityType, entityId, encoded)
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the original failure; the connection will fail subsequent health checks.
      }
      throw error
    }
  }

  private rows(sql: string, ...values: SqlPrimitive[]): SqlRow[] {
    this.assertOpen()
    return this.database.prepare(sql).all(...values).map(asSqlRow)
  }

  private firstRow(sql: string, ...values: SqlPrimitive[]): SqlRow | undefined {
    this.assertOpen()
    const value = this.database.prepare(sql).get(...values)
    return value === undefined ? undefined : asSqlRow(value)
  }

  private assertWritable(stage: string): void {
    this.assertOpen()
    if (this.config.readOnly) throw new Error(`dsh-memory ${stage}: store is read-only`)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('dsh-memory: store is closed')
  }
}

interface WriterLock {
  release(): void
}

function acquireWriterLock(path: string): WriterLock {
  const token = `${process.pid}:${randomUUID()}`
  const tryOpen = (): number => openSync(path, 'wx', 0o600)
  let fd: number
  try {
    fd = tryOpen()
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw new Error(`dsh-memory writer-lock: could not acquire ${path}`, { cause: error })
    }
    incrementWriterContention(path)
    if (!removeStaleLock(path)) {
      throw new Error(`dsh-memory writer-lock: another writer owns ${path}`, { cause: error })
    }
    try {
      fd = tryOpen()
    } catch (retryError) {
      if (isAlreadyExists(retryError)) incrementWriterContention(path)
      throw new Error(
        `dsh-memory writer-lock: ${isAlreadyExists(retryError) ? 'another writer owns' : 'could not acquire'} ${path}`,
        { cause: retryError },
      )
    }
  }
  try {
    writeFileSync(fd, token, { encoding: 'utf8' })
    closeSync(fd)
  } catch (writeError) {
    try { closeSync(fd) } catch { /* preserve the write failure */ }
    try { unlinkSync(path) } catch { /* preserve the write failure */ }
    throw new Error(`dsh-memory writer-lock: could not initialize ${path}`, { cause: writeError })
  }
  try {
    tryChmod(path, 0o600)
  } catch (error) {
    try {
      const current = readFileSync(path, 'utf8')
      if (current === token) unlinkSync(path)
    } catch { /* preserve the permission failure */ }
    throw new Error(`dsh-memory writer-lock: could not secure ${path}`, { cause: error })
  }
  let released = false
  return {
    release() {
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
    },
  }
}

function incrementWriterContention(path: string): void {
  writerContentionCounts.set(path, (writerContentionCounts.get(path) ?? 0) + 1)
}

function removeStaleLock(path: string): boolean {
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(isNodeError(error) && error.code === 'ESRCH')
  }
}

function readPragmaVersion(database: DatabaseSync): number {
  const row = asSqlRow(database.prepare('PRAGMA user_version').get())
  return readNumber(row, 'user_version')
}

function assertFreshDatabase(database: DatabaseSync): void {
  const row = database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type IN ('table', 'index', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name LIMIT 1`,
  ).get()
  if (row !== undefined) {
    const name = readString(asSqlRow(row), 'name')
    throw new Error(`dsh-memory schema: unversioned database is not empty (${name})`)
  }
}

/**
 * Check the application schema independently of SQLite's page-level check.
 * A hand-edited database can carry the expected user_version while still
 * missing a table or column; serving that file would turn corruption into
 * late, non-actionable query errors.
 */
function assertSchemaShape(database: DatabaseSync): void {
  const required: Readonly<Record<string, readonly string[]>> = {
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
      'exact_duplicate_id', 'similar_memory_ids_json', 'content_hash', 'content_json', 'actor_kind',
      'actor_id', 'created_at', 'reviewed_at', 'reviewer_kind', 'reviewer_id', 'decision_reason',
      'published_memory_id',
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
    memory_audit: [
      'seq', 'created_at', 'actor_kind', 'actor_id', 'action', 'entity_type', 'entity_id', 'details_json',
    ],
    memory_meta: ['key', 'value'],
    memory_fts: ['memory_id', 'subject', 'applicability', 'action_text', 'rationale'],
  }
  for (const [table, columns] of Object.entries(required)) {
    const row = database.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(table)
    if (row === undefined) throw new Error(`dsh-memory schema: missing required object ${table}`)
    const type = readString(asSqlRow(row), 'type')
    if (type !== 'table') throw new Error(`dsh-memory schema: ${table} is not a table`)
    const present = new Set(
      database.prepare(`PRAGMA table_info(${table})`).all().map(value => readString(asSqlRow(value), 'name')),
    )
    for (const column of columns) {
      if (!present.has(column)) throw new Error(`dsh-memory schema: ${table} is missing required column ${column}`)
    }
  }
  const meta = database.prepare("SELECT value FROM memory_meta WHERE key = 'schema_format'").get()
  if (meta === undefined || readString(asSqlRow(meta), 'value') !== String(STORE_SCHEMA_VERSION)) {
    throw new Error(`dsh-memory schema: memory_meta schema_format is not ${STORE_SCHEMA_VERSION}`)
  }
}

function scopePredicate(access: MemoryAccessContext): { sql: string; values: SqlPrimitive[] } {
  const clauses: string[] = []
  const values: SqlPrimitive[] = []
  if (access.includeGlobal ?? true) clauses.push("(r.scope_type = 'global' AND r.scope_key = '*')")
  for (const [type, value] of [
    ['workspace', access.workspace],
    ['repository', access.repository],
    ['session', access.session],
    ['agent', access.agent],
    ['user', access.user],
  ] as const) {
    if (value === undefined) continue
    clauses.push('(r.scope_type = ? AND r.scope_key = ?)')
    values.push(type, value)
  }
  if (clauses.length === 0) return { sql: '0', values }
  return { sql: clauses.join(' OR '), values }
}

function isVisible(record: Pick<MemoryContent, 'sensitivity' | 'scope'>, access: MemoryAccessContext): boolean {
  if (SENSITIVITY_LEVEL[record.sensitivity] > SENSITIVITY_LEVEL[access.maxSensitivity ?? 'internal']) return false
  if (record.scope.type === 'global') return (access.includeGlobal ?? true) && record.scope.key === '*'
  return record.scope.key === access[record.scope.type]
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_./:-]+/gu) ?? []
  return [...new Set(tokens.map(token => token.trim()).filter(token => token.length > 0))]
    .slice(0, 32)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ')
}

function similarityTokens(content: Pick<MemoryContent, 'subject' | 'applicability' | 'action'>): ReadonlySet<string> {
  const tokens = `${content.subject}\n${content.applicability}\n${content.action}`
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}_./:-]+/gu) ?? []
  return new Set(tokens.filter(token => token.length > 1))
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

function decodeConflictRow(row: SqlRow): MemoryConflict {
  const id = normalizeIdentifier(readString(row, 'id'), 'conflict.id')
  const leftMemoryId = normalizeIdentifier(readString(row, 'left_memory_id'), 'conflict.leftMemoryId')
  const rightMemoryId = normalizeIdentifier(readString(row, 'right_memory_id'), 'conflict.rightMemoryId')
  if (leftMemoryId === rightMemoryId) throw new Error(`dsh-memory decode: conflict ${id} must reference two records`)
  const leftRevision = assertPositiveInteger(readNumber(row, 'left_revision'), 'conflict.leftRevision')
  const rightRevision = assertPositiveInteger(readNumber(row, 'right_revision'), 'conflict.rightRevision')
  const status = readString(row, 'status')
  if (status !== 'open' && status !== 'resolved') throw new Error(`dsh-memory decode: unknown conflict status ${status}`)
  const createdAt = normalizeNow(readNumber(row, 'created_at'))
  const resolvedAt = readOptionalNumber(row, 'resolved_at')
  if (resolvedAt !== undefined && (resolvedAt < createdAt || !Number.isSafeInteger(resolvedAt))) {
    throw new Error(`dsh-memory decode: invalid conflict resolution timestamp ${id}`)
  }
  const resolverKind = readOptionalString(row, 'resolver_kind')
  const resolverId = readOptionalString(row, 'resolver_id')
  if ((resolverKind === undefined) !== (resolverId === undefined)) {
    throw new Error(`dsh-memory decode: conflict ${id} has incomplete resolver identity`)
  }
  const resolver = resolverKind === undefined
    ? undefined
    : normalizeActor({ kind: resolverKind as MemoryActor['kind'], id: resolverId! })
  if (resolver?.kind === 'agent') {
    throw new Error(`dsh-memory decode: conflict ${id} has unauthorized agent resolver`)
  }
  const resolutionValue = readOptionalString(row, 'resolution')
  const resolution = resolutionValue === undefined
    ? undefined
    : normalizeStoredReason(resolutionValue, `conflict ${id} resolution`)
  if (status === 'open' && (resolvedAt !== undefined || resolver !== undefined || resolution !== undefined)) {
    throw new Error(`dsh-memory decode: open conflict ${id} contains resolution state`)
  }
  if (status === 'resolved' && (resolvedAt === undefined || resolver === undefined || resolution === undefined)) {
    throw new Error(`dsh-memory decode: resolved conflict ${id} has incomplete resolution state`)
  }
  if (resolution !== undefined) {
    const normalizedResolution = normalizeReason(resolution)
    return Object.freeze({
      id, leftMemoryId, leftRevision, rightMemoryId, rightRevision, status: status as MemoryConflict['status'], createdAt,
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      ...(resolver === undefined ? {} : { resolver }),
      resolution: normalizedResolution,
    })
  }
  return Object.freeze({
    id, leftMemoryId, leftRevision, rightMemoryId, rightRevision, status: status as MemoryConflict['status'], createdAt,
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolver === undefined ? {} : { resolver }),
  })
}

function indexUniqueRows(
  rows: readonly SqlRow[],
  keyOf: (row: SqlRow) => string,
  label: string,
): Map<string, SqlRow> {
  const indexed = new Map<string, SqlRow>()
  for (const row of rows) {
    const key = keyOf(row)
    if (indexed.has(key)) throw new Error(`dsh-memory decode: duplicate ${label} row ${key}`)
    indexed.set(key, row)
  }
  return indexed
}

function groupEvidenceRows(rows: readonly SqlRow[]): Map<string, SqlRow[]> {
  const grouped = new Map<string, SqlRow[]>()
  for (const row of rows) {
    const memoryId = readString(row, 'memory_id')
    const revision = assertPositiveInteger(readNumber(row, 'revision'), 'evidence.revision')
    const key = revisionKey(memoryId, revision)
    const group = grouped.get(key) ?? []
    group.push(row)
    grouped.set(key, group)
  }
  return grouped
}

function asSqlRow(value: unknown): SqlRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh-memory decode: SQLite returned a non-object row')
  }
  return value as SqlRow
}

function readString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`dsh-memory decode: ${key} is not a string`)
  return value
}

function readOptionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`dsh-memory decode: ${key} is not a string or null`)
  return value
}

function readNumber(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`dsh-memory decode: ${key} is not a finite number`)
  }
  return value
}

function readOptionalNumber(row: SqlRow, key: string): number | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`dsh-memory decode: ${key} is not a finite number or null`)
  }
  return value
}

function readStatus(row: SqlRow): MemoryStatus {
  const status = readString(row, 'status') as MemoryStatus
  assertRecordStatus(status)
  return status
}

function assertRecordHeadMatchesRevision(
  row: SqlRow,
  revision: MemoryRevision,
  status: MemoryStatus,
  updatedAt: number,
): void {
  const checks: readonly [string, unknown, unknown][] = [
    ['status', status, revision.status],
    ['kind', readString(row, 'kind'), revision.kind],
    ['scope_type', readString(row, 'scope_type'), revision.scope.type],
    ['scope_key', readString(row, 'scope_key'), revision.scope.key],
    ['subject', readString(row, 'subject'), revision.subject],
    ['applicability', readString(row, 'applicability'), revision.applicability],
    ['action_text', readString(row, 'action_text'), revision.action],
    ['rationale', readString(row, 'rationale'), revision.rationale],
    ['confidence', readNumber(row, 'confidence'), revision.confidence],
    ['sensitivity', readString(row, 'sensitivity'), revision.sensitivity],
    ['owner', readString(row, 'owner'), revision.owner],
    ['expires_at', readOptionalNumber(row, 'expires_at') ?? null, revision.expiresAt ?? null],
    ['content_hash', readString(row, 'content_hash'), revision.contentHash],
    ['updated_at', updatedAt, revision.createdAt],
  ]
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) throw new Error(`dsh-memory decode: record head ${field} disagrees with revision ${revision.memoryId}@${revision.revision}`)
  }
}

function normalizeNow(value: number | undefined): number {
  const now = value ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('dsh-memory now must be a non-negative safe integer')
  return now
}

function storedText(value: string, name: string, maximum: number): string {
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (normalized.length === 0 || normalized.length > maximum || /\u0000/.test(normalized)) {
    throw new Error(`dsh-memory decode: ${name} is outside its stored text bounds`)
  }
  return normalized
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('dsh-memory query must be a string')
  const result = value.replace(/\r\n?/g, '\n').trim()
  if (result.length === 0 || result.length > 20_000) throw new Error('dsh-memory query length must be in [1, 20000]')
  if (/\u0000/.test(result)) throw new Error('dsh-memory query must not contain NUL')
  return result
}

function normalizeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`dsh-memory ${name} must be a string`)
  const result = value.trim()
  if (result.length === 0 || result.length > 500 || /[\u0000\r\n]/.test(result)) {
    throw new Error(`dsh-memory ${name} must be a non-empty single-line identifier`)
  }
  if (containsSecret(result)) throw new Error(`dsh-memory ${name} contains secret-like content`)
  if (containsPrivateContext(result)) throw new Error(`dsh-memory ${name} contains private transcript content`)
  return result
}

function assertObjectInput<T>(value: T, name: string): asserts value is T & Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`dsh-memory ${name} must be an object`)
  }
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('dsh-memory reason must be a string')
  const result = value.replace(/\r\n?/g, '\n').trim()
  if (result.length < 3 || result.length > 2_000) throw new Error('dsh-memory reason length must be in [3, 2000]')
  if (/\u0000/.test(result)) throw new Error('dsh-memory reason must not contain NUL')
  return result
}

function normalizeGovernanceReason(
  value: unknown,
  policy: ResolvedConfig['secretPolicy'],
  stage: string,
): string {
  const reason = normalizeReason(value)
  if (containsPrivateContext(reason)) {
    throw new Error(`dsh-memory ${stage}: reason contains private transcript content`)
  }
  if (!containsSecret(reason)) return reason
  if (policy === 'reject') throw new Error(`dsh-memory ${stage}: reason contains secret-like content`)
  const redacted = redactSecrets(reason)
  if (redacted.length > 2_000) throw new Error(`dsh-memory ${stage}: redacted reason exceeds the 2000-character limit`)
  return redacted
}

function normalizeStoredReason(value: unknown, name: string): string {
  const reason = normalizeReason(value)
  if (containsPrivateContext(reason) || containsSecret(reason)) {
    throw new Error(`dsh-memory decode: ${name} contains sensitive content`)
  }
  return reason
}

function normalizeOptionalNote(value: unknown): string {
  if (typeof value !== 'string') throw new Error('dsh-memory feedback.note must be a string')
  const result = value.replace(/\r\n?/g, '\n').trim()
  if (result.length === 0 || result.length > 2_000) throw new Error('dsh-memory feedback.note length must be in [1, 2000]')
  if (/\u0000/.test(result)) throw new Error('dsh-memory feedback.note must not contain NUL')
  if (containsPrivateContext(result)) throw new Error('dsh-memory feedback.note contains private transcript content')
  return result
}

function normalizeSha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`dsh-memory ${name} must be SHA-256 hex`)
  }
  return value.toLowerCase()
}

function assertCandidateOperation(value: unknown): asserts value is MemoryCandidateOperation {
  if (value !== 'create' && value !== 'update' && value !== 'contradict') {
    throw new Error(`dsh-memory proposal: unknown operation ${String(value)}`)
  }
}

function assertTargetCompatibility(
  operation: MemoryCandidateOperation,
  content: MemoryContent,
  target: MemoryRecord,
  stage: 'propose' | 'publish',
): void {
  if (content.kind !== target.kind) {
    throw new Error(`dsh-memory ${stage}: ${operation} cannot change memory kind for ${target.memoryId}`)
  }
  if (content.scope.type !== target.scope.type || content.scope.key !== target.scope.key) {
    throw new Error(`dsh-memory ${stage}: ${operation} cannot change scope for ${target.memoryId}`)
  }
  if (SENSITIVITY_LEVEL[content.sensitivity] < SENSITIVITY_LEVEL[target.sensitivity]) {
    throw new Error(`dsh-memory ${stage}: ${operation} cannot lower sensitivity for ${target.memoryId}`)
  }
}

function assertRevisionOperation(value: unknown): asserts value is MemoryRevisionOperation {
  if (!['create', 'update', 'contradict', 'invalidate', 'archive', 'revive', 'delete'].includes(value as string)) {
    throw new Error(`dsh-memory decode: unknown revision operation ${String(value)}`)
  }
}

function assertRevisionSemantics(revision: MemoryRevision, parent?: MemoryRevision): void {
  if (revision.revision === 1) {
    if (revision.parentRevision !== undefined) {
      throw new Error(`dsh-memory decode: first revision ${revision.memoryId} must not have a parent`)
    }
    if (revision.operation !== 'create' && revision.operation !== 'contradict') {
      throw new Error(`dsh-memory decode: first revision ${revision.memoryId} has invalid operation ${revision.operation}`)
    }
  } else {
    if (revision.parentRevision !== revision.revision - 1) {
      throw new Error(`dsh-memory decode: revision parent is not contiguous ${revision.memoryId}@${revision.revision}`)
    }
    if (revision.operation === 'create') {
      throw new Error(`dsh-memory decode: non-first revision cannot use create ${revision.memoryId}@${revision.revision}`)
    }
    if (parent !== undefined) {
      if (parent.revision !== revision.revision - 1) {
        throw new Error(`dsh-memory decode: revision parent mismatch ${revision.memoryId}@${revision.revision}`)
      }
      if (revision.kind !== parent.kind
        || revision.scope.type !== parent.scope.type
        || revision.scope.key !== parent.scope.key) {
        throw new Error(`dsh-memory decode: revision ${revision.memoryId}@${revision.revision} changes kind or scope`)
      }
      if (SENSITIVITY_LEVEL[revision.sensitivity] < SENSITIVITY_LEVEL[parent.sensitivity]) {
        throw new Error(`dsh-memory decode: revision ${revision.memoryId}@${revision.revision} lowers sensitivity`)
      }
      if (['contradict', 'invalidate', 'archive', 'revive', 'delete'].includes(revision.operation)
        && revision.contentHash !== parent.contentHash) {
        throw new Error(`dsh-memory decode: ${revision.operation} revision ${revision.memoryId}@${revision.revision} changes content`)
      }
      if (['invalidate', 'archive', 'revive', 'delete'].includes(revision.operation)
        && revision.actor.kind === 'agent') {
        throw new Error(`dsh-memory decode: ${revision.operation} revision ${revision.memoryId}@${revision.revision} has unauthorized agent actor`)
      }
    }
  }

  const expectedStatus: Readonly<Partial<Record<MemoryRevisionOperation, MemoryStatus>>> = {
    create: 'active',
    update: 'active',
    contradict: 'conflicted',
    invalidate: 'stale',
    archive: 'archived',
    revive: 'active',
    delete: 'deleted',
  }
  if (expectedStatus[revision.operation] !== revision.status) {
    throw new Error(`dsh-memory decode: revision ${revision.memoryId}@${revision.revision} operation/status mismatch`)
  }
  const requiresLiveWorkingExpiry = revision.operation === 'create'
    || revision.operation === 'update'
    || (revision.operation === 'contradict' && revision.parentRevision === undefined)
  if (revision.kind === 'working' && requiresLiveWorkingExpiry && (revision.scope.type !== 'session'
    || revision.expiresAt === undefined || revision.expiresAt <= revision.createdAt)) {
    throw new Error(`dsh-memory decode: working revision ${revision.memoryId}@${revision.revision} must be session-scoped and expire after creation`)
  }

  if (parent !== undefined) {
    const allowedParent: Readonly<Record<MemoryRevisionOperation, readonly MemoryStatus[]>> = {
      create: [],
      update: ['active', 'stale', 'archived'],
      contradict: ['active', 'stale', 'archived'],
      invalidate: ['active'],
      archive: ['active', 'stale', 'conflicted'],
      revive: ['stale', 'archived', 'conflicted'],
      delete: ['active', 'stale', 'archived'],
    }
    if (!allowedParent[revision.operation].includes(parent.status)) {
      throw new Error(`dsh-memory decode: invalid ${revision.operation} transition for ${revision.memoryId}@${revision.revision}`)
    }
  }
}

/** Enforce parent-dependent invariants even when startup-wide validation is disabled. */
function assertRevisionParentSemantics(revision: MemoryRevision, parentRow: SqlRow): void {
  const parentRevision = assertPositiveInteger(readNumber(parentRow, 'revision'), 'revision.parentRevision')
  if (revision.parentRevision !== parentRevision) {
    throw new Error(`dsh-memory decode: revision parent mismatch ${revision.memoryId}@${revision.revision}`)
  }
  const parentOperation = readString(parentRow, 'operation') as MemoryRevisionOperation
  assertRevisionOperation(parentOperation)
  const parentStatus = readString(parentRow, 'status') as MemoryStatus
  assertRecordStatus(parentStatus)
  normalizeActor({
    kind: readString(parentRow, 'actor_kind') as MemoryActor['kind'],
    id: readString(parentRow, 'actor_id'),
  })
  const parentKind = readString(parentRow, 'kind') as MemoryKind
  assertMemoryKind(parentKind)
  const parentScope = normalizeScope({
    type: readString(parentRow, 'scope_type') as MemoryScopeType,
    key: readString(parentRow, 'scope_key'),
  })
  const parentSensitivity = readString(parentRow, 'sensitivity') as MemorySensitivity
  assertSensitivity(parentSensitivity)
  const parentHash = normalizeSha256(readString(parentRow, 'content_hash'), 'revision.parentContentHash')
  if (revision.kind !== parentKind
    || revision.scope.type !== parentScope.type
    || revision.scope.key !== parentScope.key) {
    throw new Error(`dsh-memory decode: revision ${revision.memoryId}@${revision.revision} changes kind or scope`)
  }
  if (SENSITIVITY_LEVEL[revision.sensitivity] < SENSITIVITY_LEVEL[parentSensitivity]) {
    throw new Error(`dsh-memory decode: revision ${revision.memoryId}@${revision.revision} lowers sensitivity`)
  }
  if (['contradict', 'invalidate', 'archive', 'revive', 'delete'].includes(revision.operation)
    && revision.contentHash !== parentHash) {
    throw new Error(`dsh-memory decode: ${revision.operation} revision ${revision.memoryId}@${revision.revision} changes content`)
  }
  if (['invalidate', 'archive', 'revive', 'delete'].includes(revision.operation)
    && revision.actor.kind === 'agent') {
    throw new Error(`dsh-memory decode: ${revision.operation} revision ${revision.memoryId}@${revision.revision} has unauthorized agent actor`)
  }
  const allowedParent: Readonly<Record<MemoryRevisionOperation, readonly MemoryStatus[]>> = {
    create: [],
    update: ['active', 'stale', 'archived'],
    contradict: ['active', 'stale', 'archived'],
    invalidate: ['active'],
    archive: ['active', 'stale', 'conflicted'],
    revive: ['stale', 'archived', 'conflicted'],
    delete: ['active', 'stale', 'archived'],
  }
  if (!allowedParent[revision.operation].includes(parentStatus)) {
    throw new Error(`dsh-memory decode: invalid ${revision.operation} transition for ${revision.memoryId}@${revision.revision}`)
  }
}

/** Validate the complete immutable revision chain, including parent state transitions. */
function validateRevisionHistory(
  revisions: readonly MemoryRevision[],
  recordIds: ReadonlySet<string>,
  stage: 'integrity' | 'restore-export',
): void {
  const byRecord = new Map<string, MemoryRevision[]>()
  const keys = new Set<string>()
  for (const revision of revisions) {
    if (!recordIds.has(revision.memoryId)) {
      throw new Error(`dsh-memory ${stage}: revision references unknown record ${revision.memoryId}`)
    }
    const key = revisionKey(revision.memoryId, revision.revision)
    if (keys.has(key)) throw new Error(`dsh-memory ${stage}: duplicate revision ${key}`)
    keys.add(key)
    const group = byRecord.get(revision.memoryId) ?? []
    group.push(revision)
    byRecord.set(revision.memoryId, group)
  }

  for (const [memoryId, unsorted] of byRecord) {
    const group = [...unsorted].sort((left, right) => left.revision - right.revision)
    if (group[0]?.revision !== 1) {
      throw new Error(`dsh-memory ${stage}: revision history must start at 1 for ${memoryId}`)
    }
    for (let index = 0; index < group.length; index += 1) {
      const revision = group[index]!
      const parent = index === 0 ? undefined : group[index - 1]
      if (revision.revision !== index + 1) {
        throw new Error(`dsh-memory ${stage}: revision history has a gap for ${memoryId}`)
      }
      try {
        assertRevisionSemantics(revision, parent)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message.replace('dsh-memory decode:', `dsh-memory ${stage}:`), { cause: error })
      }
      if (parent !== undefined && revision.createdAt < parent.createdAt) {
        throw new Error(`dsh-memory ${stage}: revision timestamps move backwards for ${memoryId}`)
      }
    }
  }
}

/**
 * Validate candidate lineage all the way to the immutable revisions it
 * describes. IDs alone are insufficient: a damaged row could point at an
 * unrelated record and still pass a foreign-key check.
 */
function validateCandidateReferences(
  candidates: readonly MemoryCandidate[],
  records: readonly MemoryRecord[],
  revisions: readonly MemoryRevision[],
  conflicts: readonly MemoryConflict[],
  stage: 'integrity' | 'restore-export',
): void {
  const byRecord = new Map(records.map(record => [record.memoryId, record]))
  const byRevision = new Map(revisions.map(revision => [revisionKey(revision.memoryId, revision.revision), revision]))
  const revisionsByRecord = new Map<string, MemoryRevision[]>()
  for (const revision of revisions) {
    const group = revisionsByRecord.get(revision.memoryId) ?? []
    group.push(revision)
    revisionsByRecord.set(revision.memoryId, group)
  }
  const unknown = (candidate: MemoryCandidate, relation: string, id: string): never => {
    if (stage === 'integrity') {
      throw new Error(`dsh-memory integrity: candidate ${candidate.id} references missing memory ${id}`)
    }
    throw new Error(`dsh-memory restore-export: candidate ${candidate.id} references unknown ${relation}`)
  }
  const invalid = (candidate: MemoryCandidate, message: string): never => {
    throw new Error(`dsh-memory ${stage}: candidate ${candidate.id} ${message}`)
  }
  const sameContentDomain = (left: MemoryContent, right: MemoryContent): boolean =>
    left.kind === right.kind
    && left.scope.type === right.scope.type
    && left.scope.key === right.scope.key
  const recordHasHash = (memoryId: string, hash: string): boolean =>
    (revisionsByRecord.get(memoryId) ?? []).some(revision => revision.contentHash === hash)
  const recordRevision = (memoryId: string, revision: number): MemoryRevision | undefined =>
    byRevision.get(revisionKey(memoryId, revision))

  for (const candidate of candidates) {
    const target = candidate.targetMemoryId === undefined
      ? undefined
      : byRecord.get(candidate.targetMemoryId)
    if (candidate.targetMemoryId !== undefined && target === undefined) {
      unknown(candidate, 'target', candidate.targetMemoryId)
    }
    if (candidate.expectedRevision !== undefined) {
      if (candidate.targetMemoryId === undefined
        || recordRevision(candidate.targetMemoryId, candidate.expectedRevision) === undefined) {
        if (stage === 'integrity') {
          throw new Error(`dsh-memory integrity: candidate ${candidate.id} references missing target revision`)
        }
        throw new Error(`dsh-memory restore-export: candidate ${candidate.id} references unknown target revision`)
      }
    }
    if (target !== undefined && !sameContentDomain(candidate.content, target)) {
      invalid(candidate, 'target changes memory kind or scope')
    }

    if (candidate.exactDuplicateId !== undefined) {
      const duplicate = byRecord.get(candidate.exactDuplicateId)
      if (duplicate === undefined) {
        unknown(candidate, 'duplicate', candidate.exactDuplicateId)
        continue
      }
      if (!sameContentDomain(candidate.content, duplicate)) {
        invalid(candidate, 'exact duplicate is outside the candidate kind or scope')
      }
      if (!recordHasHash(duplicate.memoryId, candidate.contentHash)) {
        invalid(candidate, 'exact duplicate does not contain the candidate content')
      }
      if (candidate.similarMemoryIds.includes(candidate.exactDuplicateId)) {
        invalid(candidate, 'lists its exact duplicate as a similar memory')
      }
    }

    const seenSimilar = new Set<string>()
    for (const similarId of candidate.similarMemoryIds) {
      const similar = byRecord.get(similarId)
      if (similar === undefined) {
        unknown(candidate, 'similar memory', similarId)
        continue
      }
      if (seenSimilar.has(similarId)) invalid(candidate, 'contains duplicate similar memory references')
      seenSimilar.add(similarId)
      if (candidate.targetMemoryId === similarId) {
        invalid(candidate, 'lists its target as a similar memory')
      }
      if (!sameContentDomain(candidate.content, similar)) {
        invalid(candidate, 'lists a similar memory outside its kind or scope')
      }
    }

    if (candidate.publishedMemoryId === undefined) continue
    const published = byRecord.get(candidate.publishedMemoryId)
    if (published === undefined) {
      unknown(candidate, 'published memory', candidate.publishedMemoryId)
      continue
    }
    const publishedRevisions = revisionsByRecord.get(published.memoryId) ?? []
    if (candidate.operation === 'create') {
      const first = publishedRevisions.find(revision => revision.revision === 1)
      if (first === undefined || first.operation !== 'create' || first.contentHash !== candidate.contentHash) {
        invalid(candidate, 'published reference does not point to its create revision')
      }
      continue
    }

    const expected = candidate.expectedRevision
    const targetId = candidate.targetMemoryId
    if (expected === undefined || targetId === undefined) {
      invalid(candidate, 'published reference is missing its target revision')
      continue
    }
    if (candidate.operation === 'update') {
      if (candidate.publishedMemoryId !== targetId) {
        invalid(candidate, 'update published a different memory')
      }
      if (!Number.isSafeInteger(expected + 1)) {
        invalid(candidate, 'update publication revision is outside safe integer bounds')
      }
      const publication = recordRevision(targetId, expected + 1)
      if (publication === undefined || publication.operation !== 'update'
        || publication.contentHash !== candidate.contentHash) {
        invalid(candidate, 'published reference does not point to its update revision')
      }
      continue
    }

    if (candidate.publishedMemoryId === targetId) {
      invalid(candidate, 'contradiction published the target as its own right-hand record')
    }
    const rightFirst = publishedRevisions.find(revision => revision.revision === 1)
    const leftContradiction = Number.isSafeInteger(expected + 1)
      ? recordRevision(targetId, expected + 1)
      : undefined
    if (rightFirst === undefined || rightFirst.operation !== 'contradict'
      || rightFirst.status !== 'conflicted' || rightFirst.contentHash !== candidate.contentHash
      || leftContradiction === undefined || leftContradiction.operation !== 'contradict'
      || leftContradiction.status !== 'conflicted') {
      invalid(candidate, 'published reference does not point to both contradiction revisions')
    }
    const hasConflict = conflicts.some(conflict =>
      (conflict.leftMemoryId === targetId
        && conflict.leftRevision === expected + 1
        && conflict.rightMemoryId === candidate.publishedMemoryId
        && conflict.rightRevision === 1)
      || (conflict.rightMemoryId === targetId
        && conflict.rightRevision === expected + 1
        && conflict.leftMemoryId === candidate.publishedMemoryId
        && conflict.leftRevision === 1))
    if (!hasConflict) invalid(candidate, 'published contradiction has no conflict record')
  }
}

/** Check that conflict rows point to the immutable contradiction revisions they describe. */
function validateConflictState(
  conflicts: readonly MemoryConflict[],
  records: readonly MemoryRecord[],
  revisions: readonly MemoryRevision[],
  stage: 'integrity' | 'restore-export',
): void {
  const byRecord = new Map(records.map(record => [record.memoryId, record]))
  const byRevision = new Map(revisions.map(revision => [revisionKey(revision.memoryId, revision.revision), revision]))
  const openOwners = new Map<string, string>()
  for (const conflict of conflicts) {
    const left = byRecord.get(conflict.leftMemoryId)
    const right = byRecord.get(conflict.rightMemoryId)
    const leftRevision = byRevision.get(revisionKey(conflict.leftMemoryId, conflict.leftRevision))
    const rightRevision = byRevision.get(revisionKey(conflict.rightMemoryId, conflict.rightRevision))
    if (left === undefined || right === undefined || leftRevision === undefined || rightRevision === undefined) {
      throw new Error(`dsh-memory ${stage}: conflict ${conflict.id} references missing record or revision`)
    }
    if (leftRevision.operation !== 'contradict' || leftRevision.status !== 'conflicted'
      || rightRevision.operation !== 'contradict' || rightRevision.status !== 'conflicted') {
      throw new Error(`dsh-memory ${stage}: conflict ${conflict.id} does not reference contradiction revisions`)
    }
    if (leftRevision.kind !== rightRevision.kind
      || leftRevision.scope.type !== rightRevision.scope.type
      || leftRevision.scope.key !== rightRevision.scope.key) {
      throw new Error(`dsh-memory ${stage}: conflict ${conflict.id} crosses kind or scope`)
    }
    const earliestConflict = Math.max(leftRevision.createdAt, rightRevision.createdAt)
    if (conflict.createdAt < earliestConflict) {
      throw new Error(`dsh-memory ${stage}: conflict ${conflict.id} predates its contradiction revisions`)
    }
    if (conflict.status === 'open') {
      if (left.status !== 'conflicted' || right.status !== 'conflicted'
        || left.revision !== conflict.leftRevision || right.revision !== conflict.rightRevision) {
        throw new Error(`dsh-memory ${stage}: open conflict ${conflict.id} is not current on both records`)
      }
      for (const memoryId of [conflict.leftMemoryId, conflict.rightMemoryId]) {
        const owner = openOwners.get(memoryId)
        if (owner !== undefined && owner !== conflict.id) {
          throw new Error(`dsh-memory ${stage}: record ${memoryId} belongs to multiple open conflicts`)
        }
        openOwners.set(memoryId, conflict.id)
      }
    }
  }

  for (const record of records) {
    if (record.status === 'conflicted' && !openOwners.has(record.memoryId)) {
      throw new Error(`dsh-memory ${stage}: conflicted record ${record.memoryId} has no open conflict owner`)
    }
  }

  // A resolved row is only truthful after both records have advanced beyond
  // the contradiction heads. A later open conflict may legitimately make one
  // of those records conflicted again, so that state is allowed only when an
  // active conflict owns the current head.
  for (const conflict of conflicts) {
    if (conflict.status !== 'resolved') continue
    const left = byRecord.get(conflict.leftMemoryId)!
    const right = byRecord.get(conflict.rightMemoryId)!
    const leftCurrent = byRevision.get(revisionKey(left.memoryId, left.revision))
    const rightCurrent = byRevision.get(revisionKey(right.memoryId, right.revision))
    if (leftCurrent === undefined || rightCurrent === undefined
      || left.revision <= conflict.leftRevision || right.revision <= conflict.rightRevision) {
      throw new Error(`dsh-memory ${stage}: resolved conflict ${conflict.id} records did not advance past contradiction revisions`)
    }
    if (conflict.resolvedAt === undefined
      || leftCurrent.createdAt < conflict.resolvedAt
      || rightCurrent.createdAt < conflict.resolvedAt) {
      throw new Error(`dsh-memory ${stage}: resolved conflict ${conflict.id} has inconsistent resolution timing`)
    }
    for (const record of [left, right]) {
      if (record.status === 'conflicted' && !openOwners.has(record.memoryId)) {
        throw new Error(`dsh-memory ${stage}: resolved conflict ${conflict.id} leaves ${record.memoryId} conflicted without an open owner`)
      }
    }
  }
}

/** Validate that telemetry claims only an authorized, active revision was delivered. */
function validateRetrievalReferences(
  retrievals: readonly MemoryRetrievalLog[],
  records: readonly MemoryRecord[],
  revisions: readonly MemoryRevision[],
  stage: 'integrity' | 'restore-export',
): void {
  const recordIds = new Set(records.map(record => record.memoryId))
  const byRevision = new Map(revisions.map(revision => [revisionKey(revision.memoryId, revision.revision), revision]))
  for (const retrieval of retrievals) {
    for (const selected of retrieval.selected) {
      if (!recordIds.has(selected.memoryId)) continue
      const revision = byRevision.get(revisionKey(selected.memoryId, selected.revision))
      if (revision === undefined) continue
      if (retrieval.createdAt < revision.createdAt) {
        throw new Error(`dsh-memory ${stage}: retrieval ${retrieval.id} predates selected revision`)
      }
      if (revision.status !== 'active') {
        throw new Error(`dsh-memory ${stage}: retrieval ${retrieval.id} selected a non-active revision`)
      }
      if (revision.expiresAt !== undefined && revision.expiresAt <= retrieval.createdAt) {
        throw new Error(`dsh-memory ${stage}: retrieval ${retrieval.id} selected an expired revision`)
      }
      if (!isVisible(revision, retrieval.context)) {
        throw new Error(`dsh-memory ${stage}: retrieval ${retrieval.id} selected a revision outside its access scope`)
      }
    }
  }
}

/** Feedback counters are denormalized ranking inputs and must match the rows. */
function validateFeedbackCounters(
  records: readonly MemoryRecord[],
  feedback: readonly MemoryFeedbackRecord[],
  stage: 'integrity' | 'restore-export',
): void {
  const counts = new Map<string, { positive: number; negative: number }>()
  for (const item of feedback) {
    const current = counts.get(item.memoryId) ?? { positive: 0, negative: 0 }
    if (item.kind === 'helpful') current.positive += 1
    else current.negative += 1
    counts.set(item.memoryId, current)
  }
  for (const record of records) {
    const current = counts.get(record.memoryId) ?? { positive: 0, negative: 0 }
    if (record.positiveFeedback !== current.positive || record.negativeFeedback !== current.negative) {
      throw new Error(`dsh-memory ${stage}: feedback counters disagree for ${record.memoryId}`)
    }
  }
}

function revisionKey(memoryId: string, revision: number): string {
  return `${memoryId}\u0000${revision}`
}

function assertMemoryKind(value: unknown): asserts value is MemoryKind {
  if (value !== 'working' && value !== 'episodic' && value !== 'semantic' && value !== 'procedural') {
    throw new Error(`dsh-memory decode: unknown memory kind ${String(value)}`)
  }
}

function assertSensitivity(value: unknown): asserts value is MemorySensitivity {
  if (value !== 'public' && value !== 'internal' && value !== 'confidential') {
    throw new Error(`dsh-memory decode: unknown sensitivity ${String(value)}`)
  }
}

function assertEvidenceKind(value: unknown): asserts value is EvidenceReference['kind'] {
  if (value !== 'session-event' && value !== 'file' && value !== 'commit'
    && value !== 'test' && value !== 'url' && value !== 'human') {
    throw new Error(`dsh-memory decode: unknown evidence kind ${String(value)}`)
  }
}

function assertTransitionAction(value: unknown): asserts value is MemoryTransitionInput['action'] {
  if (value !== 'invalidate' && value !== 'archive' && value !== 'revive' && value !== 'delete') {
    throw new Error(`dsh-memory transition: unknown action ${String(value)}`)
  }
}

function assertCandidateStatus(value: unknown): asserts value is MemoryCandidateStatus {
  if (value !== 'candidate' && value !== 'published' && value !== 'rejected' && value !== 'skipped') {
    throw new Error(`dsh-memory: unknown candidate status ${String(value)}`)
  }
}

function assertFeedbackKind(value: unknown): asserts value is MemoryFeedbackKind {
  if (value !== 'helpful' && value !== 'harmful' && value !== 'irrelevant' && value !== 'stale') {
    throw new Error(`dsh-memory: unknown feedback kind ${String(value)}`)
  }
}

function assertRecordStatus(value: unknown): asserts value is MemoryStatus {
  if (value !== 'active' && value !== 'conflicted' && value !== 'stale' && value !== 'archived' && value !== 'deleted') {
    throw new Error(`dsh-memory: unknown record status ${String(value)}`)
  }
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`dsh-memory ${name} must be a positive integer`)
  }
  return value
}

function assertNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dsh-memory ${name} must be a non-negative integer`)
  }
  return value
}

function assertFinite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`dsh-memory ${name} must be finite`)
  return value
}

function assertNonNegative(value: unknown, name: string): number {
  const number = assertFinite(value, name)
  if (number < 0) throw new Error(`dsh-memory ${name} must be non-negative`)
  return number
}

function assertBoundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const result = assertNonNegativeInteger(value, name)
  if (result < minimum || result > maximum) {
    throw new Error(`dsh-memory ${name} must be an integer in [${minimum}, ${maximum}]`)
  }
  return result
}

function assertBoundedNumber(value: unknown, name: string, minimum: number, maximum: number): number {
  const result = assertFinite(value, name)
  if (result < minimum || result > maximum) {
    throw new Error(`dsh-memory ${name} must be a number in [${minimum}, ${maximum}]`)
  }
  return result
}

function retentionCutoff(now: number, days: number): number | undefined {
  if (days === 0) return undefined
  return Math.max(0, now - days * 86_400_000)
}

function mutationCount(result: { readonly changes: number | bigint }): number {
  const value = Number(result.changes)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('dsh-memory mutation count is invalid')
  return value
}

function validatedListLimit(value: unknown, name: string): number {
  return assertBoundedInteger(value, `list.${name}.limit`, 1, 100_000)
}

function decodeSelectedReferences(value: unknown): MemorySelectedReference[] {
  if (!Array.isArray(value)) throw new Error('dsh-memory decode: retrieval selection must be an array')
  const selected = value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`dsh-memory decode: retrieval selection ${index} must be an object`)
    }
    const row = item as Record<string, unknown>
    return Object.freeze({
      memoryId: normalizeIdentifier(row.memoryId, `retrieval.selected[${index}].memoryId`),
      revision: assertPositiveInteger(row.revision, `retrieval.selected[${index}].revision`),
      score: assertNonNegative(row.score, `retrieval.selected[${index}].score`),
    })
  })
  if (new Set(selected.map(item => revisionKey(item.memoryId, item.revision))).size !== selected.length) {
    throw new Error('dsh-memory decode: retrieval selection contains duplicates')
  }
  return selected
}

function assertSameRetrieval(row: SqlRow, expected: RetrievalComparable, id: string): void {
  // Duration, wall-clock creation time, and ranking scores are observational
  // fields. A replay with the same durable retrieval id may run after restart
  // or at a different age; the selected record/revision sequence and budget
  // contract must still match.
  const storedSelected = decodeSelectedReferences(
    parseJson(readString(row, 'selected_json'), 'retrieval selection'),
  )
  const expectedSelected = decodeSelectedReferences(parseJson(expected.selectedJson, 'retrieval selection'))
  const sameSelection = storedSelected.length === expectedSelected.length
    && storedSelected.every((item, index) => {
      const other = expectedSelected[index]
      return other !== undefined && item.memoryId === other.memoryId && item.revision === other.revision
    })
  const same = readString(row, 'query_hash') === expected.queryHash
    && (readOptionalString(row, 'query_text') ?? null) === expected.queryText
    && readString(row, 'context_json') === expected.contextJson
    && readNumber(row, 'candidate_count') === expected.candidateCount
    && sameSelection
    && readNumber(row, 'token_budget') === expected.tokenBudget
    && readNumber(row, 'estimated_tokens') === expected.estimatedTokens
    && (readOptionalString(row, 'session_id') ?? null) === expected.sessionId
    && (readOptionalNumber(row, 'turn_number') ?? null) === expected.turn
  if (!same) throw new Error(`dsh-memory record-retrieval: id ${id} already exists with different data`)
}

function decodeIdentifierArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`dsh-memory decode: ${name} must be an array`)
  const values = value.map((item, index) => normalizeIdentifier(item, `${name}[${index}]`))
  if (new Set(values).size !== values.length) throw new Error(`dsh-memory decode: ${name} contains duplicates`)
  return values
}

function blankRecordCounts(): Record<MemoryStatus, number> {
  return { active: 0, conflicted: 0, stale: 0, archived: 0, deleted: 0 }
}

function blankCandidateCounts(): Record<MemoryCandidateStatus, number> {
  return { candidate: 0, published: 0, rejected: 0, skipped: 0 }
}

function blankFeedbackCounts(): Record<MemoryFeedbackKind, number> {
  return { helpful: 0, harmful: 0, irrelevant: 0, stale: 0 }
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`dsh-memory decode: invalid ${name} JSON`, { cause: error })
  }
}

function validateExport(input: unknown, config: ResolvedConfig): MemoryExport {
  const value = exportObject(input)
  if (value.format !== 'dsh-memory-export' || value.version !== 1) {
    throw new Error('dsh-memory restore-export: unsupported export format or version')
  }
  const exportedAt = exportTimestamp(value.exportedAt, 'exportedAt')
  const records = exportArray(value.records, 'records').map(item => validateExportRecord(item, config))
  const revisions = exportArray(value.revisions, 'revisions').map(item => validateExportRevision(item, config))
  const candidates = exportArray(value.candidates, 'candidates').map(item => validateExportCandidate(item, config))
  const conflicts = exportArray(value.conflicts, 'conflicts').map(validateExportConflict)
  const retrievals = value.retrievals === undefined
    ? []
    : exportArray(value.retrievals, 'retrievals').map(validateExportRetrieval)
  const feedbackProvided = value.feedback !== undefined
  const feedback = !feedbackProvided
    ? []
    : exportArray(value.feedback, 'feedback').map(validateExportFeedback)
  const audit = value.audit === undefined
    ? []
    : exportArray(value.audit, 'audit').map(validateExportAudit)
  const recordIds = new Set<string>()
  for (const record of records) {
    if (recordIds.has(record.memoryId)) throw new Error(`dsh-memory restore-export: duplicate record ${record.memoryId}`)
    recordIds.add(record.memoryId)
  }
  const byRecord = new Map(records.map(record => [record.memoryId, record]))
  const revisionKeys = new Set<string>()
  const maximumRevisionByRecord = new Map<string, number>()
  const revisionsByRecord = new Map<string, MemoryRevision[]>()
  for (const revision of revisions) {
    const key = revisionKey(revision.memoryId, revision.revision)
    if (revisionKeys.has(key)) throw new Error(`dsh-memory restore-export: duplicate revision ${key}`)
    revisionKeys.add(key)
    const record = byRecord.get(revision.memoryId)
    if (record === undefined) throw new Error(`dsh-memory restore-export: revision references unknown ${revision.memoryId}`)
    if (revision.revision > 1 && revision.parentRevision !== revision.revision - 1) {
      throw new Error(`dsh-memory restore-export: revision chain is not contiguous for ${revision.memoryId}`)
    }
    if (revision.revision === 1 && revision.parentRevision !== undefined) {
      throw new Error(`dsh-memory restore-export: first revision cannot have a parent for ${revision.memoryId}`)
    }
    if (contentHash(revision) !== revision.contentHash) {
      throw new Error(`dsh-memory restore-export: content hash mismatch at ${key}`)
    }
    if (record.revision === revision.revision && record.contentHash !== revision.contentHash) {
      throw new Error(`dsh-memory restore-export: head hash mismatch at ${key}`)
    }
    maximumRevisionByRecord.set(
      revision.memoryId,
      Math.max(maximumRevisionByRecord.get(revision.memoryId) ?? 0, revision.revision),
    )
    const group = revisionsByRecord.get(revision.memoryId) ?? []
    group.push(revision)
    revisionsByRecord.set(revision.memoryId, group)
  }
  validateRevisionHistory(revisions, recordIds, 'restore-export')
  validateConflictState(conflicts, records, revisions, 'restore-export')
  validateCandidateReferences(candidates, records, revisions, conflicts, 'restore-export')
  for (const revision of revisions) {
    if (revision.revision > 1 && !revisionKeys.has(revisionKey(revision.memoryId, revision.revision - 1))) {
      throw new Error(`dsh-memory restore-export: revision chain has a missing parent for ${revision.memoryId}:${revision.revision}`)
    }
  }
  for (const record of records) {
    if (!revisionKeys.has(revisionKey(record.memoryId, record.revision))) {
      throw new Error(`dsh-memory restore-export: missing current revision for ${record.memoryId}`)
    }
    if (maximumRevisionByRecord.get(record.memoryId) !== record.revision) {
      throw new Error(`dsh-memory restore-export: record head is not the latest revision for ${record.memoryId}`)
    }
    const group = [...(revisionsByRecord.get(record.memoryId) ?? [])].sort((left, right) => left.revision - right.revision)
    const first = group[0]
    const head = group[group.length - 1]
    if (first === undefined || head === undefined || first.revision !== 1 || head.revision !== record.revision) {
      throw new Error(`dsh-memory restore-export: incomplete revision history for ${record.memoryId}`)
    }
    if (record.createdAt !== first.createdAt || record.updatedAt !== head.createdAt) {
      throw new Error(`dsh-memory restore-export: record timestamps disagree with revision history for ${record.memoryId}`)
    }
    if (record.status !== head.status || record.operation !== head.operation
      || record.actor.kind !== head.actor.kind || record.actor.id !== head.actor.id
      || record.parentRevision !== head.parentRevision) {
      throw new Error(`dsh-memory restore-export: record head metadata disagrees with revision history for ${record.memoryId}`)
    }
    for (let index = 1; index < group.length; index += 1) {
      if (group[index]!.createdAt < group[index - 1]!.createdAt) {
        throw new Error(`dsh-memory restore-export: revision timestamps move backwards for ${record.memoryId}`)
      }
    }
  }
  const candidateIds = new Set<string>()
  const requestIds = new Set<string>()
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) throw new Error(`dsh-memory restore-export: duplicate candidate ${candidate.id}`)
    candidateIds.add(candidate.id)
    if (candidate.requestId !== undefined) {
      if (requestIds.has(candidate.requestId)) throw new Error(`dsh-memory restore-export: duplicate request id ${candidate.requestId}`)
      requestIds.add(candidate.requestId)
    }
  }
  const conflictIds = new Set<string>()
  for (const conflict of conflicts) {
    if (conflictIds.has(conflict.id)) throw new Error(`dsh-memory restore-export: duplicate conflict ${conflict.id}`)
    conflictIds.add(conflict.id)
    const left = byRecord.get(conflict.leftMemoryId)
    const right = byRecord.get(conflict.rightMemoryId)
    if (left === undefined || right === undefined) throw new Error(`dsh-memory restore-export: conflict references unknown record`)
    if (!revisionKeys.has(revisionKey(conflict.leftMemoryId, conflict.leftRevision))
      || !revisionKeys.has(revisionKey(conflict.rightMemoryId, conflict.rightRevision))) {
      throw new Error(`dsh-memory restore-export: conflict references unknown revision`)
    }
    if (conflict.leftMemoryId === conflict.rightMemoryId) {
      throw new Error(`dsh-memory restore-export: conflict ${conflict.id} must reference two records`)
    }
    if (conflict.status === 'open'
      && (left.status !== 'conflicted' || right.status !== 'conflicted'
        || left.revision !== conflict.leftRevision || right.revision !== conflict.rightRevision)) {
      throw new Error(`dsh-memory restore-export: open conflict ${conflict.id} is not current on both records`)
    }
  }
  const retrievalIds = new Set<string>()
  const retrievalById = new Map<string, MemoryRetrievalLog>()
  for (const retrieval of retrievals) {
    if (retrievalIds.has(retrieval.id)) throw new Error(`dsh-memory restore-export: duplicate retrieval ${retrieval.id}`)
    if (retrieval.selected.length > retrieval.candidateCount) {
      throw new Error(`dsh-memory restore-export: retrieval ${retrieval.id} selected count exceeds candidate count`)
    }
    if (retrieval.estimatedTokens > retrieval.tokenBudget) {
      throw new Error(`dsh-memory restore-export: retrieval ${retrieval.id} exceeds token budget`)
    }
    retrievalIds.add(retrieval.id)
    retrievalById.set(retrieval.id, retrieval)
    for (const selected of retrieval.selected) {
      if (!byRecord.has(selected.memoryId) || !revisionKeys.has(revisionKey(selected.memoryId, selected.revision))) {
        throw new Error(`dsh-memory restore-export: retrieval ${retrieval.id} references unknown revision`)
      }
    }
  }
  validateRetrievalReferences(retrievals, records, revisions, 'restore-export')
  const feedbackIds = new Set<string>()
  for (const item of feedback) {
    if (feedbackIds.has(item.id)) throw new Error(`dsh-memory restore-export: duplicate feedback ${item.id}`)
    feedbackIds.add(item.id)
    if (!byRecord.has(item.memoryId) || !revisionKeys.has(revisionKey(item.memoryId, item.revision))) {
      throw new Error(`dsh-memory restore-export: feedback ${item.id} references unknown revision`)
    }
    if (item.retrievalId !== undefined && !retrievalIds.has(item.retrievalId)) {
      throw new Error(`dsh-memory restore-export: feedback ${item.id} references unknown retrieval`)
    }
    if (item.retrievalId !== undefined
      && !retrievalById.get(item.retrievalId)?.selected.some(selected =>
        selected.memoryId === item.memoryId && selected.revision === item.revision)) {
      throw new Error(`dsh-memory restore-export: feedback ${item.id} retrieval did not select its memory`)
    }
  }
  // Pre-v2 exports did not carry feedback rows. Their denormalized counters
  // remain authoritative because the source rows are intentionally absent.
  if (feedbackProvided) validateFeedbackCounters(records, feedback, 'restore-export')
  const auditSeqs = new Set<number>()
  let previousAuditSeq = 0
  for (const item of audit) {
    if (auditSeqs.has(item.seq)) throw new Error(`dsh-memory restore-export: duplicate audit sequence ${item.seq}`)
    if (item.seq <= previousAuditSeq) throw new Error('dsh-memory restore-export: audit rows must be ordered by sequence')
    auditSeqs.add(item.seq)
    previousAuditSeq = item.seq
  }
  return Object.freeze({
    format: 'dsh-memory-export',
    version: 1,
    exportedAt,
    records,
    revisions,
    candidates,
    conflicts,
    retrievals,
    feedback,
    audit,
  })
}

function validateExportRecord(input: unknown, config: ResolvedConfig): MemoryRecord {
  const value = exportObject(input)
  const createdAt = exportTimestamp(value.createdAt, 'record.createdAt')
  const content = exportContent(value, config, createdAt, true)
  const memoryId = normalizeIdentifier(value.memoryId, 'record.memoryId')
  const revision = assertPositiveInteger(value.revision, 'record.revision')
  const operation = exportRevisionOperation(value.operation)
  assertHistoricalWorkingContent(content, createdAt, 'record', operation, value.parentRevision)
  const status = exportRecordStatus(value.status)
  const actor = normalizeActor(exportObject(value.actor) as unknown as MemoryActor)
  const contentHashValue = normalizeSha256(value.contentHash, 'record.contentHash')
  if (contentHash(content) !== contentHashValue) throw new Error(`dsh-memory restore-export: record hash mismatch ${memoryId}`)
  const updatedAt = exportTimestamp(value.updatedAt, 'record.updatedAt')
  const lastUsedAt = value.lastUsedAt === undefined ? undefined : exportTimestamp(value.lastUsedAt, 'record.lastUsedAt')
  if (updatedAt < createdAt) throw new Error(`dsh-memory restore-export: record updated_at precedes creation ${memoryId}`)
  if (lastUsedAt !== undefined && lastUsedAt < createdAt) {
    throw new Error(`dsh-memory restore-export: record last_used_at precedes creation ${memoryId}`)
  }
  return Object.freeze({
    ...content, memoryId, revision, ...(value.parentRevision === undefined ? {} : { parentRevision: assertPositiveInteger(value.parentRevision, 'record.parentRevision') }),
    operation, actor, contentHash: contentHashValue, createdAt, status,
    updatedAt,
    positiveFeedback: assertNonNegativeInteger(value.positiveFeedback, 'record.positiveFeedback'),
    negativeFeedback: assertNonNegativeInteger(value.negativeFeedback, 'record.negativeFeedback'),
    useCount: assertNonNegativeInteger(value.useCount, 'record.useCount'),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  })
}

function validateExportRevision(input: unknown, config: ResolvedConfig): MemoryRevision {
  const value = exportObject(input)
  const createdAt = exportTimestamp(value.createdAt, 'revision.createdAt')
  const content = exportContent(value, config, createdAt, true)
  const memoryId = normalizeIdentifier(value.memoryId, 'revision.memoryId')
  const revision = assertPositiveInteger(value.revision, 'revision.revision')
  const operation = exportRevisionOperation(value.operation)
  assertHistoricalWorkingContent(content, createdAt, 'revision', operation, value.parentRevision)
  const contentHashValue = normalizeSha256(value.contentHash, 'revision.contentHash')
  if (contentHash(content) !== contentHashValue) throw new Error(`dsh-memory restore-export: revision hash mismatch ${memoryId}@${revision}`)
  return Object.freeze({
    ...content, memoryId, revision,
    ...(value.parentRevision === undefined ? {} : { parentRevision: assertPositiveInteger(value.parentRevision, 'revision.parentRevision') }),
    operation, status: exportRecordStatus(value.status),
    actor: normalizeActor(exportObject(value.actor) as unknown as MemoryActor),
    contentHash: contentHashValue, createdAt,
  })
}

function validateExportCandidate(input: unknown, config: ResolvedConfig): MemoryCandidate {
  const value = exportObject(input)
  const content = exportContent(value.content, config, exportTimestamp(value.createdAt, 'candidate.createdAt'))
  const id = normalizeIdentifier(value.id, 'candidate.id')
  const status = exportCandidateStatus(value.status)
  const contentHashValue = normalizeSha256(value.contentHash, 'candidate.contentHash')
  if (contentHash(content) !== contentHashValue) throw new Error(`dsh-memory restore-export: candidate hash mismatch ${id}`)
  const candidate: MemoryCandidate = Object.freeze({
    id,
    ...(value.requestId === undefined ? {} : { requestId: normalizeIdentifier(value.requestId, 'candidate.requestId') }),
    operation: (() => { assertCandidateOperation(value.operation); return value.operation })(), status, content,
    actor: normalizeActor(exportObject(value.actor) as unknown as MemoryActor),
    ...(value.targetMemoryId === undefined ? {} : { targetMemoryId: normalizeIdentifier(value.targetMemoryId, 'candidate.targetMemoryId') }),
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: assertPositiveInteger(value.expectedRevision, 'candidate.expectedRevision') }),
    ...(value.exactDuplicateId === undefined ? {} : { exactDuplicateId: normalizeIdentifier(value.exactDuplicateId, 'candidate.exactDuplicateId') }),
    similarMemoryIds: Object.freeze(value.similarMemoryIds === undefined
      ? []
      : decodeIdentifierArray(value.similarMemoryIds, 'candidate.similarMemoryIds')),
    contentHash: contentHashValue, createdAt: exportTimestamp(value.createdAt, 'candidate.createdAt'),
    ...(value.reviewedAt === undefined ? {} : { reviewedAt: exportTimestamp(value.reviewedAt, 'candidate.reviewedAt') }),
    ...(value.reviewer === undefined ? {} : { reviewer: normalizeActor(exportObject(value.reviewer) as unknown as MemoryActor) }),
    ...(value.decisionReason === undefined ? {} : {
      decisionReason: normalizeExportReason(value.decisionReason, 'candidate.decisionReason'),
    }),
    ...(value.publishedMemoryId === undefined ? {} : { publishedMemoryId: normalizeIdentifier(value.publishedMemoryId, 'candidate.publishedMemoryId') }),
  })
  validateCandidateState(candidate)
  return candidate
}

function validateCandidateState(candidate: MemoryCandidate): void {
  const hasTarget = candidate.targetMemoryId !== undefined || candidate.expectedRevision !== undefined
  if (candidate.operation === 'create' && hasTarget) {
    throw new Error(`dsh-memory restore-export: create candidate ${candidate.id} must not have a target`)
  }
  if (candidate.operation !== 'create'
    && (candidate.targetMemoryId === undefined || candidate.expectedRevision === undefined)) {
    throw new Error(`dsh-memory restore-export: ${candidate.operation} candidate ${candidate.id} requires a target revision`)
  }

  const hasReview = candidate.reviewedAt !== undefined
    || candidate.reviewer !== undefined
    || candidate.decisionReason !== undefined
  if (candidate.status === 'candidate' && (hasReview || candidate.publishedMemoryId !== undefined)) {
    throw new Error(`dsh-memory restore-export: pending candidate ${candidate.id} contains review state`)
  }
  if (candidate.status !== 'candidate'
    && (candidate.reviewedAt === undefined || candidate.reviewer === undefined || candidate.decisionReason === undefined)) {
    throw new Error(`dsh-memory restore-export: reviewed candidate ${candidate.id} has incomplete review state`)
  }
  if (candidate.reviewedAt !== undefined && candidate.reviewedAt < candidate.createdAt) {
    throw new Error(`dsh-memory restore-export: candidate ${candidate.id} review timestamp precedes creation`)
  }
  if (candidate.reviewer?.kind === 'agent') {
    throw new Error(`dsh-memory restore-export: candidate ${candidate.id} has unauthorized agent reviewer`)
  }
  if ((candidate.status === 'published') !== (candidate.publishedMemoryId !== undefined)) {
    throw new Error(`dsh-memory restore-export: candidate ${candidate.id} has inconsistent publication state`)
  }
  if (candidate.exactDuplicateId !== undefined && candidate.status !== 'skipped') {
    throw new Error(`dsh-memory restore-export: candidate ${candidate.id} has inconsistent duplicate state`)
  }
  if (candidate.status === 'published' && candidate.operation === 'update'
    && candidate.publishedMemoryId !== candidate.targetMemoryId) {
    throw new Error(`dsh-memory restore-export: update candidate ${candidate.id} published a different target`)
  }
}

function validateExportConflict(input: unknown): MemoryConflict {
  const value = exportObject(input)
  const status = value.status
  if (status !== 'open' && status !== 'resolved') throw new Error('dsh-memory restore-export: unknown conflict status')
  const conflict: MemoryConflict = Object.freeze({
    id: normalizeIdentifier(value.id, 'conflict.id'),
    leftMemoryId: normalizeIdentifier(value.leftMemoryId, 'conflict.leftMemoryId'),
    leftRevision: assertPositiveInteger(value.leftRevision, 'conflict.leftRevision'),
    rightMemoryId: normalizeIdentifier(value.rightMemoryId, 'conflict.rightMemoryId'),
    rightRevision: assertPositiveInteger(value.rightRevision, 'conflict.rightRevision'),
    status, createdAt: exportTimestamp(value.createdAt, 'conflict.createdAt'),
    ...(value.resolvedAt === undefined ? {} : { resolvedAt: exportTimestamp(value.resolvedAt, 'conflict.resolvedAt') }),
    ...(value.resolver === undefined ? {} : { resolver: normalizeActor(exportObject(value.resolver) as unknown as MemoryActor) }),
    ...(value.resolution === undefined ? {} : { resolution: normalizeExportReason(value.resolution, 'conflict.resolution') }),
  })
  if (conflict.resolver?.kind === 'agent') {
    throw new Error(`dsh-memory restore-export: conflict ${conflict.id} has unauthorized agent resolver`)
  }
  if (conflict.leftMemoryId === conflict.rightMemoryId) {
    throw new Error(`dsh-memory restore-export: conflict ${conflict.id} must reference two records`)
  }
  if (conflict.resolvedAt !== undefined && conflict.resolvedAt < conflict.createdAt) {
    throw new Error(`dsh-memory restore-export: conflict ${conflict.id} resolution timestamp precedes creation`)
  }
  const hasResolution = conflict.resolvedAt !== undefined
    || conflict.resolver !== undefined
    || conflict.resolution !== undefined
  if (conflict.status === 'open' && hasResolution) {
    throw new Error(`dsh-memory restore-export: open conflict ${conflict.id} contains resolution state`)
  }
  if (conflict.status === 'resolved'
    && (conflict.resolvedAt === undefined || conflict.resolver === undefined || conflict.resolution === undefined)) {
    throw new Error(`dsh-memory restore-export: resolved conflict ${conflict.id} has incomplete resolution state`)
  }
  return conflict
}

function normalizeExportReason(value: unknown, name: string): string {
  const reason = normalizeReason(value)
  if (containsPrivateContext(reason)) throw new Error(`dsh-memory restore-export: ${name} contains private transcript content`)
  if (containsSecret(reason)) throw new Error(`dsh-memory restore-export: ${name} contains secret-like content`)
  return reason
}

function validateExportRetrieval(input: unknown): MemoryRetrievalLog {
  const value = exportObject(input)
  const id = normalizeIdentifier(value.id, 'retrieval.id')
  const queryHashValue = normalizeSha256(value.queryHash, 'retrieval.queryHash')
  const queryText = value.queryText === undefined ? undefined : normalizeQuery(value.queryText)
  if (queryText !== undefined && (containsSecret(queryText) || containsPrivateContext(queryText))) {
    throw new Error(`dsh-memory restore-export: retrieval query text contains sensitive content ${id}`)
  }
  if (queryText !== undefined && queryHash(queryText) !== queryHashValue) {
    throw new Error(`dsh-memory restore-export: retrieval query hash mismatch ${id}`)
  }
  const context = normalizeAccessContext(exportObject(value.context) as MemoryAccessContext)
  const selected = decodeSelectedReferences(value.selected)
  if (selected.length > 100) throw new Error(`dsh-memory restore-export: retrieval selection is too large ${id}`)
  const candidateCount = assertNonNegativeInteger(value.candidateCount, 'retrieval.candidateCount')
  const tokenBudget = assertNonNegativeInteger(value.tokenBudget, 'retrieval.tokenBudget')
  const estimatedTokens = assertNonNegativeInteger(value.estimatedTokens, 'retrieval.estimatedTokens')
  if (selected.length > candidateCount) {
    throw new Error(`dsh-memory restore-export: retrieval ${id} selected count exceeds candidate count`)
  }
  if (estimatedTokens > tokenBudget) {
    throw new Error(`dsh-memory restore-export: retrieval ${id} exceeds token budget`)
  }
  return Object.freeze({
    id,
    queryHash: queryHashValue,
    ...(queryText === undefined ? {} : { queryText }),
    context,
    candidateCount,
    selected: Object.freeze(selected),
    tokenBudget,
    estimatedTokens,
    durationMs: assertNonNegative(value.durationMs, 'retrieval.durationMs'),
    ...(value.sessionId === undefined ? {} : { sessionId: normalizeIdentifier(value.sessionId, 'retrieval.sessionId') }),
    ...(value.turn === undefined ? {} : { turn: assertNonNegativeInteger(value.turn, 'retrieval.turn') }),
    createdAt: exportTimestamp(value.createdAt, 'retrieval.createdAt'),
  })
}

function validateExportFeedback(input: unknown): MemoryFeedbackRecord {
  const value = exportObject(input)
  const note = value.note === undefined ? undefined : normalizeOptionalNote(value.note)
  if (note !== undefined && containsSecret(note)) {
    throw new Error('dsh-memory restore-export: feedback note contains secret-like content')
  }
  const kind = value.kind as MemoryFeedbackKind
  assertFeedbackKind(kind)
  return Object.freeze({
    id: normalizeIdentifier(value.id, 'feedback.id'),
    memoryId: normalizeIdentifier(value.memoryId, 'feedback.memoryId'),
    revision: assertPositiveInteger(value.revision, 'feedback.revision'),
    ...(value.retrievalId === undefined ? {} : { retrievalId: normalizeIdentifier(value.retrievalId, 'feedback.retrievalId') }),
    kind,
    actor: normalizeActor(exportObject(value.actor) as unknown as MemoryActor),
    ...(note === undefined ? {} : { note }),
    createdAt: exportTimestamp(value.createdAt, 'feedback.createdAt'),
  })
}

function validateExportAudit(input: unknown): MemoryAuditRecord {
  const value = exportObject(input)
  const details = exportObject(value.details)
  const encoded = JSON.stringify(details)
  if (encoded.length > 16_000) throw new Error('dsh-memory restore-export: audit details are too large')
  if (containsPrivateContext(encoded)) throw new Error('dsh-memory restore-export: audit details contain private transcript content')
  if (containsSecret(encoded)) throw new Error('dsh-memory restore-export: audit details contain secret-like content')
  return Object.freeze({
    seq: assertPositiveInteger(value.seq, 'audit.seq'),
    createdAt: exportTimestamp(value.createdAt, 'audit.createdAt'),
    actor: normalizeActor(exportObject(value.actor) as unknown as MemoryActor),
    action: normalizeIdentifier(value.action, 'audit.action'),
    entityType: normalizeIdentifier(value.entityType, 'audit.entityType'),
    entityId: normalizeIdentifier(value.entityId, 'audit.entityId'),
    details: Object.freeze(details),
  })
}

function exportContent(
  input: unknown,
  config: ResolvedConfig,
  now: number,
  allowExpiredWorking = false,
): MemoryContent {
  const value = exportObject(input)
  return normalizeContent({
    kind: value.kind,
    scope: value.scope,
    subject: value.subject,
    applicability: value.applicability,
    action: value.action,
    rationale: value.rationale,
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    owner: value.owner,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    evidence: value.evidence,
  } as MemoryContent, {
    now,
    maxChars: config.maxCandidateChars,
    maxWorkingTtlHours: config.maxWorkingTtlHours,
    secretPolicy: 'reject',
    allowExpiredWorking,
  })
}

function assertHistoricalWorkingContent(
  content: MemoryContent,
  createdAt: number,
  name: string,
  operation: MemoryRevisionOperation,
  parentRevision: unknown,
): void {
  if (content.kind !== 'working') return
  // Lifecycle revisions retain the prior content and may be written after its
  // TTL has elapsed. New content (create/update and the right side of a first
  // contradiction) must still have a live expiry at its own creation time.
  const requiresLiveExpiry = operation === 'create'
    || operation === 'update'
    || (operation === 'contradict' && parentRevision === undefined)
  if (!requiresLiveExpiry) return
  if (content.scope.type !== 'session' || content.expiresAt === undefined || content.expiresAt <= createdAt) {
    throw new Error(`dsh-memory restore-export: ${name} working content must expire after creation`)
  }
}

function exportObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('dsh-memory restore-export: expected object')
  return input as Record<string, unknown>
}

function isDefinedExportField(input: unknown, field: string): boolean {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && (input as Record<string, unknown>)[field] !== undefined
}

function exportArray(input: unknown, name: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`dsh-memory restore-export: ${name} must be an array`)
  return input
}

function exportTimestamp(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) throw new Error(`dsh-memory restore-export: ${name} must be a timestamp`)
  return input
}

function exportRevisionOperation(input: unknown): MemoryRevisionOperation {
  if (!['create', 'update', 'contradict', 'invalidate', 'archive', 'revive', 'delete'].includes(input as string)) throw new Error(`dsh-memory restore-export: unknown revision operation ${String(input)}`)
  return input as MemoryRevisionOperation
}

function exportRecordStatus(input: unknown): MemoryStatus {
  assertRecordStatus(input)
  return input
}

function exportCandidateStatus(input: unknown): MemoryCandidateStatus {
  assertCandidateStatus(input)
  return input
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST'
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function assertCanonicalDatabasePath(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`dsh-memory open: storage path must be a regular non-symlink file: ${path}`)
    }
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
}

function addStage(error: unknown, stage: string): Error {
  if (error instanceof Error && error.message.startsWith('dsh-memory')) return error
  return new Error(`dsh-memory ${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}

/** Stable privacy-safe content fingerprint used by tests and exports. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
