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
  normalizeAccessContext,
  normalizeActor,
  normalizeContent,
  queryHash,
} from './content.ts'
import { CREATE_SCHEMA_SQL, STORE_SCHEMA_VERSION } from './schema.ts'
import type {
  EvidenceReference,
  MemoryAccessContext,
  MemoryActor,
  MemoryCandidate,
  MemoryCandidateOperation,
  MemoryCandidateStatus,
  MemoryConflict,
  MemoryConflictResolutionInput,
  MemoryContent,
  MemoryExport,
  MemoryFeedbackInput,
  MemoryHealth,
  MemoryKind,
  MemoryProposalInput,
  MemoryRecord,
  MemoryRetrievalLogInput,
  MemoryReviewInput,
  MemoryRevision,
  MemoryRevisionOperation,
  MemoryScopeType,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySensitivity,
  MemoryStats,
  MemoryStatus,
  MemoryTransitionInput,
} from './types.ts'

type SqlPrimitive = string | number | bigint | null | Uint8Array
type SqlRow = Record<string, SqlPrimitive>

const SENSITIVITY_LEVEL: Readonly<Record<MemorySensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
}

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
    const now = normalizeNow(input.now)
    const actor = normalizeActor(input.actor)
    const content = normalizeContent(input.content, {
      now,
      maxChars: this.config.maxCandidateChars,
      maxWorkingTtlHours: this.config.maxWorkingTtlHours,
      secretPolicy: this.config.secretPolicy,
    })
    const operation = input.operation ?? 'create'
    assertCandidateOperation(operation)
    const target = this.validateProposalTarget(operation, input.targetMemoryId, input.expectedRevision)
    const hash = contentHash(content)

    const requestId = input.requestId === undefined
      ? undefined
      : normalizeIdentifier(input.requestId, 'requestId')
    if (requestId !== undefined) {
      const existing = this.candidateByRequestId(requestId)
      if (existing !== undefined) {
        if (existing.contentHash !== hash) {
          throw new Error('dsh-memory propose: requestId was already used for different content')
        }
        return existing
      }
    }

    const queuedDuplicate = this.firstRow(
      `SELECT * FROM memory_candidates
       WHERE content_hash = ? AND status = 'candidate' AND operation = ?
       AND COALESCE(target_memory_id, '') = COALESCE(?, '')
       ORDER BY created_at, id LIMIT 1`,
      hash,
      operation,
      target?.id ?? null,
    )
    if (queuedDuplicate !== undefined) return this.decodeCandidateRow(queuedDuplicate)

    const exactRecord = this.firstRow(
      `SELECT id FROM memory_records
       WHERE content_hash = ? AND status IN ('active', 'conflicted', 'stale', 'archived')
       ORDER BY updated_at DESC, id LIMIT 1`,
      hash,
    )
    const exactDuplicateId = exactRecord === undefined ? undefined : readString(exactRecord, 'id')
    const candidate: MemoryCandidate = Object.freeze({
      id: randomUUID(),
      ...(requestId === undefined ? {} : { requestId }),
      operation,
      status: exactDuplicateId === undefined ? 'candidate' : 'skipped',
      content,
      actor,
      ...(target === undefined ? {} : { targetMemoryId: target.id, expectedRevision: target.revision }),
      ...(exactDuplicateId === undefined ? {} : { exactDuplicateId }),
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
          exact_duplicate_id, content_hash, content_json, actor_kind, actor_id,
          created_at, reviewed_at, reviewer_kind, reviewer_id, decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.id,
        candidate.requestId ?? null,
        candidate.operation,
        candidate.status,
        candidate.targetMemoryId ?? null,
        candidate.expectedRevision ?? null,
        candidate.exactDuplicateId ?? null,
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
    const id = normalizeIdentifier(candidateId, 'candidateId')
    const now = normalizeNow(input.now)
    const reviewer = normalizeActor(input.actor)
    if (reviewer.kind === 'agent') throw new Error('dsh-memory review: agent actors cannot review candidates')
    const reason = normalizeReason(input.reason)
    if (!['publish', 'reject', 'skip'].includes(input.action)) {
      throw new Error(`dsh-memory review: unknown action ${String(input.action)}`)
    }

    return this.transaction(() => {
      const candidate = this.requireCandidate(id)
      if (candidate.status !== 'candidate') {
        throw new Error(`dsh-memory review: candidate ${id} is already ${candidate.status}`)
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
    this.assertWritable(input.action)
    const id = normalizeIdentifier(memoryId, 'memoryId')
    const actor = normalizeActor(input.actor)
    if (actor.kind === 'agent') throw new Error(`dsh-memory ${input.action}: agent actors are not authorized`)
    const now = normalizeNow(input.now)
    const reason = normalizeReason(input.reason)
    const targetStatus: Readonly<Record<MemoryTransitionInput['action'], MemoryStatus>> = {
      invalidate: 'stale',
      archive: 'archived',
      revive: 'active',
      delete: 'deleted',
    }
    return this.transaction(() => {
      const current = this.requireRecordUnscoped(id)
      if (current.revision !== input.expectedRevision) {
        throw new Error(
          `dsh-memory ${input.action}: optimistic revision mismatch for ${id} `
          + `(expected ${input.expectedRevision}, current ${current.revision})`,
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
    const reason = normalizeReason(reasonInput)
    const now = normalizeNow(nowInput)
    this.transaction(() => {
      const record = this.requireRecordUnscoped(id)
      if (record.status !== 'deleted') throw new Error('dsh-memory purge: logical delete is required first')
      this.database.prepare('DELETE FROM memory_candidates WHERE target_memory_id = ? OR exact_duplicate_id = ?').run(id, id)
      this.removeFts(id)
      this.database.prepare('DELETE FROM memory_records WHERE id = ?').run(id)
      this.audit(actor, 'record.purge', 'memory', id, {
        lastRevision: record.revision,
        lastContentHash: record.contentHash,
        reason,
      }, now)
    })
  }

  get(memoryId: string, access: MemoryAccessContext, includeEvidence = true): MemoryRecord | undefined {
    const id = normalizeIdentifier(memoryId, 'memoryId')
    const record = this.recordUnscoped(id, includeEvidence)
    if (record === undefined || !isVisible(record, normalizeAccessContext(access))) return undefined
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
    if (statuses.length === 0) return []
    for (const status of statuses) assertRecordStatus(status)
    const placeholders = statuses.map(() => '?').join(', ')
    return this.rows(
      `SELECT * FROM memory_records WHERE status IN (${placeholders}) ORDER BY scope_type, scope_key, subject, id`,
      ...statuses,
    ).map(row => this.decodeRecordRow(row, true))
  }

  listRevisions(memoryId?: string): readonly MemoryRevision[] {
    const rows = memoryId === undefined
      ? this.rows('SELECT * FROM memory_revisions ORDER BY memory_id, revision')
      : this.rows(
          'SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision',
          normalizeIdentifier(memoryId, 'memoryId'),
        )
    return rows.map(row => this.decodeRevisionRow(row, true))
  }

  listConflicts(status: 'open' | 'resolved' = 'open'): readonly MemoryConflict[] {
    return this.rows(
      'SELECT * FROM memory_conflicts WHERE status = ? ORDER BY created_at, id',
      status,
    ).map(decodeConflictRow)
  }

  resolveConflict(conflictId: string, input: MemoryConflictResolutionInput): MemoryConflict {
    this.assertWritable('resolve-conflict')
    const id = normalizeIdentifier(conflictId, 'conflictId')
    const actor = normalizeActor(input.actor)
    if (actor.kind === 'agent') throw new Error('dsh-memory resolve-conflict: agent actors are not authorized')
    const reason = normalizeReason(input.reason)
    const now = normalizeNow(input.now)
    if (!['keep-left', 'keep-right', 'keep-both', 'archive-both'].includes(input.action)) {
      throw new Error(`dsh-memory resolve-conflict: unknown action ${String(input.action)}`)
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
      const statuses: readonly ['active' | 'archived', 'active' | 'archived'] = input.action === 'keep-left'
        ? ['active', 'archived']
        : input.action === 'keep-right'
          ? ['archived', 'active']
          : input.action === 'keep-both'
            ? ['active', 'active']
            : ['archived', 'archived']
      const leftRevision = this.resolveConflictedRecord(left, statuses[0], actor, now)
      const rightRevision = this.resolveConflictedRecord(right, statuses[1], actor, now)
      const resolution = `${input.action}: ${reason}`
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
    const query = normalizeQuery(queryInput)
    const hash = queryHash(query)
    const access = normalizeAccessContext(accessInput)
    const now = normalizeNow(options.now)
    const limit = options.limit ?? this.config.retrievalCandidateLimit
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('dsh-memory search.limit must be an integer in [1, 100]')
    }
    const kinds = options.kinds ?? this.config.injectedKinds
    const ftsQuery = toFtsQuery(query)
    if (ftsQuery.length === 0) return Object.freeze({ queryHash: hash, hits: [], durationMs: performance.now() - started })

    const { sql: scopeSql, values: scopeValues } = scopePredicate(access)
    const kindPlaceholders = kinds.map(() => '?').join(', ')
    const sensitivity = SENSITIVITY_LEVEL[access.maxSensitivity ?? 'internal']
    const rows = this.rows(
      `SELECT r.*, bm25(memory_fts, 8.0, 3.0, 5.0, 1.0) AS lexical_rank
       FROM memory_fts
       JOIN memory_records r ON r.id = memory_fts.memory_id
       WHERE memory_fts MATCH ?
         AND r.status = 'active'
         AND (r.expires_at IS NULL OR r.expires_at > ?)
         AND r.confidence >= ?
         AND r.kind IN (${kindPlaceholders})
         AND CASE r.sensitivity WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END <= ?
         AND (${scopeSql})
       ORDER BY lexical_rank ASC, r.id ASC
       LIMIT ?`,
      ftsQuery,
      now,
      this.config.minConfidence,
      ...kinds,
      sensitivity,
      ...scopeValues,
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
      return Object.freeze({ record, score, reasons: Object.freeze(reasons) })
    }).sort((left, right) => right.score - left.score
      || left.record.memoryId.localeCompare(right.record.memoryId))

    return Object.freeze({
      queryHash: hash,
      hits: Object.freeze(hits.slice(0, limit)),
      durationMs: performance.now() - started,
    })
  }

  recordRetrieval(input: MemoryRetrievalLogInput): void {
    this.assertWritable('record-retrieval')
    const now = normalizeNow(input.now)
    const id = normalizeIdentifier(input.id, 'retrievalId')
    const selected = input.selected.map(item => ({
      memoryId: normalizeIdentifier(item.memoryId, 'selected.memoryId'),
      revision: assertPositiveInteger(item.revision, 'selected.revision'),
      score: assertFinite(item.score, 'selected.score'),
    }))
    this.transaction(() => {
      this.database.prepare(
        `INSERT INTO memory_retrievals (
          id, query_hash, query_text, context_json, candidate_count, selected_json,
          token_budget, estimated_tokens, duration_ms, session_id, turn_number, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        normalizeSha256(input.queryHash, 'queryHash'),
        this.config.logQueryText ? input.queryText ?? null : null,
        JSON.stringify(normalizeAccessContext(input.context)),
        assertNonNegativeInteger(input.candidateCount, 'candidateCount'),
        JSON.stringify(selected),
        assertNonNegativeInteger(input.tokenBudget, 'tokenBudget'),
        assertNonNegativeInteger(input.estimatedTokens, 'estimatedTokens'),
        assertNonNegative(input.durationMs, 'durationMs'),
        input.sessionId ?? null,
        input.turn ?? null,
        now,
      )
      const update = this.database.prepare(
        `UPDATE memory_records SET use_count = use_count + 1, last_used_at = ?
         WHERE id = ? AND current_revision = ?`,
      )
      for (const item of selected) update.run(now, item.memoryId, item.revision)
      this.audit({ kind: 'system', id: 'retrieval-accounting' }, 'retrieval.record', 'retrieval', id, {
        candidateCount: input.candidateCount,
        selectedCount: selected.length,
        estimatedTokens: input.estimatedTokens,
      }, now)
    })
  }

  feedback(input: MemoryFeedbackInput): void {
    this.assertWritable('feedback')
    const now = normalizeNow(input.now)
    const actor = normalizeActor(input.actor)
    const id = normalizeIdentifier(input.memoryId, 'memoryId')
    if (!['helpful', 'harmful', 'irrelevant', 'stale'].includes(input.kind)) {
      throw new Error(`dsh-memory feedback: unknown kind ${String(input.kind)}`)
    }
    const note = input.note === undefined ? undefined : normalizeOptionalNote(input.note)
    this.transaction(() => {
      const record = this.requireRecordUnscoped(id)
      if (record.revision !== input.revision) {
        throw new Error(`dsh-memory feedback: revision ${input.revision} is not current for ${id}`)
      }
      this.database.prepare(
        `INSERT INTO memory_feedback (
          id, memory_id, revision, retrieval_id, kind, actor_kind, actor_id, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), id, input.revision, input.retrievalId ?? null, input.kind, actor.kind, actor.id, note ?? null, now)
      if (input.kind === 'helpful') {
        this.database.prepare('UPDATE memory_records SET positive_feedback = positive_feedback + 1 WHERE id = ?').run(id)
      } else {
        this.database.prepare('UPDATE memory_records SET negative_feedback = negative_feedback + 1 WHERE id = ?').run(id)
      }
      this.audit(actor, `feedback.${input.kind}`, 'memory', id, {
        revision: input.revision,
        retrievalId: input.retrievalId ?? null,
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
    })
  }

  /** Restore a portable export into an empty store after validating every reference. */
  restoreExport(input: unknown): void {
    this.assertWritable('restore-export')
    const exportValue = validateExport(input, this.config)
    const existing = this.firstRow(
      'SELECT (SELECT COUNT(*) FROM memory_records) + (SELECT COUNT(*) FROM memory_candidates) AS count',
    )
    if (existing !== undefined && readNumber(existing, 'count') !== 0) {
      throw new Error('dsh-memory restore-export: destination store must be empty')
    }
    this.transaction(() => {
      for (const record of exportValue.records) {
        this.insertExportRecord(record)
      }
      for (const revision of exportValue.revisions) {
        this.insertExportRevision(revision)
      }
      for (const candidate of exportValue.candidates) {
        this.database.prepare(
          `INSERT INTO memory_candidates (
            id, request_id, operation, status, target_memory_id, expected_revision,
            exact_duplicate_id, content_hash, content_json, actor_kind, actor_id,
            created_at, reviewed_at, reviewer_kind, reviewer_id, decision_reason, published_memory_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          candidate.id,
          candidate.requestId ?? null,
          candidate.operation,
          candidate.status,
          candidate.targetMemoryId ?? null,
          candidate.expectedRevision ?? null,
          candidate.exactDuplicateId ?? null,
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
      for (const record of exportValue.records) {
        if (record.status === 'active') this.upsertFts(record)
      }
      this.audit({ kind: 'migration', id: 'portable-restore' }, 'restore.export', 'store', this.config.storagePath, {
        records: exportValue.records.length,
        revisions: exportValue.revisions.length,
        candidates: exportValue.candidates.length,
        conflicts: exportValue.conflicts.length,
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

  private configure(): void {
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;')
    if (!this.config.readOnly) {
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const current = readPragmaVersion(this.database)
      if (current === 0) {
        this.transaction(() => {
          this.database.exec(CREATE_SCHEMA_SQL)
          this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)
        })
      } else if (current > STORE_SCHEMA_VERSION) {
        throw new Error(
          `dsh-memory schema: store version ${current} is newer than supported ${STORE_SCHEMA_VERSION}`,
        )
      } else if (current < STORE_SCHEMA_VERSION) {
        throw new Error(`dsh-memory schema: no migration from ${current} to ${STORE_SCHEMA_VERSION}`)
      }
    } else {
      const current = readPragmaVersion(this.database)
      if (current !== STORE_SCHEMA_VERSION) {
        throw new Error(
          `dsh-memory schema: read-only store version ${current} does not match ${STORE_SCHEMA_VERSION}`,
        )
      }
    }
  }

  private publishCandidate(candidate: MemoryCandidate, reviewer: MemoryActor, now: number): MemoryRecord {
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
    this.database.prepare("UPDATE memory_records SET status = 'conflicted', updated_at = ? WHERE id = ?").run(now, targetId)
    this.removeFts(targetId)
    this.removeFts(rightId)
    const conflictId = randomUUID()
    this.database.prepare(
      `INSERT INTO memory_conflicts (
        id, left_memory_id, left_revision, right_memory_id, right_revision, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    ).run(conflictId, targetId, target.revision, rightId, rightRevision.revision, now)
    this.audit(reviewer, 'conflict.open', 'conflict', conflictId, {
      leftMemoryId: targetId,
      leftRevision: target.revision,
      rightMemoryId: rightId,
      rightRevision: rightRevision.revision,
    }, now)
    return this.requireRecordUnscoped(rightId)
  }

  private validateProposalTarget(
    operation: MemoryCandidateOperation,
    targetMemoryId: string | undefined,
    expectedRevision: number | undefined,
  ): { id: string; revision: number } | undefined {
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
    return { id, revision }
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
    this.database.prepare(
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

  private decodeRecordRow(row: SqlRow, includeEvidence: boolean): MemoryRecord {
    const memoryId = readString(row, 'id')
    const revision = readNumber(row, 'current_revision')
    const revisionRow = this.firstRow(
      'SELECT * FROM memory_revisions WHERE memory_id = ? AND revision = ?',
      memoryId,
      revision,
    )
    if (revisionRow === undefined) throw new Error(`dsh-memory decode: missing revision ${memoryId}@${revision}`)
    const base = this.decodeRevisionRow(revisionRow, includeEvidence)
    const lastUsedAt = readOptionalNumber(row, 'last_used_at')
    return Object.freeze({
      ...base,
      status: readStatus(row),
      updatedAt: readNumber(row, 'updated_at'),
      positiveFeedback: readNumber(row, 'positive_feedback'),
      negativeFeedback: readNumber(row, 'negative_feedback'),
      useCount: readNumber(row, 'use_count'),
      ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    })
  }

  private decodeRevisionRow(row: SqlRow, includeEvidence: boolean): MemoryRevision {
    const memoryId = readString(row, 'memory_id')
    const revision = readNumber(row, 'revision')
    const evidence = includeEvidence ? this.readEvidence(memoryId, revision) : []
    const parentRevision = readOptionalNumber(row, 'parent_revision')
    const expiresAt = readOptionalNumber(row, 'expires_at')
    return Object.freeze({
      memoryId,
      revision,
      ...(parentRevision === undefined ? {} : { parentRevision }),
      operation: readString(row, 'operation') as MemoryRevisionOperation,
      status: readString(row, 'status') as MemoryStatus,
      actor: Object.freeze({
        kind: readString(row, 'actor_kind') as MemoryActor['kind'],
        id: readString(row, 'actor_id'),
      }),
      kind: readString(row, 'kind') as MemoryKind,
      scope: Object.freeze({
        type: readString(row, 'scope_type') as MemoryScopeType,
        key: readString(row, 'scope_key'),
      }),
      subject: readString(row, 'subject'),
      applicability: readString(row, 'applicability'),
      action: readString(row, 'action_text'),
      rationale: readString(row, 'rationale'),
      confidence: readNumber(row, 'confidence'),
      sensitivity: readString(row, 'sensitivity') as MemorySensitivity,
      owner: readString(row, 'owner'),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      evidence: Object.freeze(evidence),
      contentHash: readString(row, 'content_hash'),
      createdAt: readNumber(row, 'created_at'),
    })
  }

  private decodeCandidateRow(row: SqlRow): MemoryCandidate {
    const contentValue: unknown = parseJson(readString(row, 'content_json'), 'candidate content')
    const createdAt = readNumber(row, 'created_at')
    const content = normalizeContent(contentValue as MemoryContent, {
      now: createdAt,
      maxChars: this.config.maxCandidateChars,
      maxWorkingTtlHours: this.config.maxWorkingTtlHours,
      secretPolicy: 'reject',
    })
    const actor = normalizeActor({
      kind: readString(row, 'actor_kind') as MemoryActor['kind'],
      id: readString(row, 'actor_id'),
    })
    const reviewerKind = readOptionalString(row, 'reviewer_kind')
    const reviewerId = readOptionalString(row, 'reviewer_id')
    const reviewer = reviewerKind === undefined || reviewerId === undefined
      ? undefined
      : normalizeActor({ kind: reviewerKind as MemoryActor['kind'], id: reviewerId })
    const targetMemoryId = readOptionalString(row, 'target_memory_id')
    const expectedRevision = readOptionalNumber(row, 'expected_revision')
    const exactDuplicateId = readOptionalString(row, 'exact_duplicate_id')
    const requestId = readOptionalString(row, 'request_id')
    const publishedMemoryId = readOptionalString(row, 'published_memory_id')
    const reviewedAt = readOptionalNumber(row, 'reviewed_at')
    const decisionReason = readOptionalString(row, 'decision_reason')
    return Object.freeze({
      id: readString(row, 'id'),
      ...(requestId === undefined ? {} : { requestId }),
      operation: readString(row, 'operation') as MemoryCandidateOperation,
      status: readString(row, 'status') as MemoryCandidateStatus,
      content,
      actor,
      ...(targetMemoryId === undefined ? {} : { targetMemoryId }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(exactDuplicateId === undefined ? {} : { exactDuplicateId }),
      contentHash: readString(row, 'content_hash'),
      createdAt,
      ...(reviewedAt === undefined ? {} : { reviewedAt }),
      ...(reviewer === undefined ? {} : { reviewer }),
      ...(decisionReason === undefined ? {} : { decisionReason }),
      ...(publishedMemoryId === undefined ? {} : { publishedMemoryId }),
    })
  }

  private readEvidence(memoryId: string, revision: number): EvidenceReference[] {
    return this.rows(
      `SELECT * FROM memory_evidence WHERE memory_id = ? AND revision = ? ORDER BY ordinal`,
      memoryId,
      revision,
    ).map(row => {
      const note = readOptionalString(row, 'note')
      const observedAt = readOptionalNumber(row, 'observed_at')
      const hash = readOptionalString(row, 'content_hash')
      return Object.freeze({
        kind: readString(row, 'kind') as EvidenceReference['kind'],
        locator: readString(row, 'locator'),
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
    this.database.prepare(
      `INSERT INTO memory_audit (
        created_at, actor_kind, actor_id, action, entity_type, entity_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, actor.kind, actor.id, action, entityType, entityId, JSON.stringify(details))
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
    if (!isAlreadyExists(error) || !removeStaleLock(path)) {
      throw new Error(`dsh-memory writer-lock: another writer owns ${path}`, { cause: error })
    }
    fd = tryOpen()
  }
  writeFileSync(fd, token, { encoding: 'utf8' })
  closeSync(fd)
  tryChmod(path, 0o600)
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

function removeStaleLock(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    const value = readFileSync(path, 'utf8')
    const match = /^(\d+):/.exec(value)
    if (match === null) return false
    const pid = Number(match[1])
    if (Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid)) return false
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
    return isPermissionError(error)
  }
}

function readPragmaVersion(database: DatabaseSync): number {
  const row = asSqlRow(database.prepare('PRAGMA user_version').get())
  return readNumber(row, 'user_version')
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

function isVisible(record: MemoryRecord, access: MemoryAccessContext): boolean {
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

function decodeConflictRow(row: SqlRow): MemoryConflict {
  const resolvedAt = readOptionalNumber(row, 'resolved_at')
  const resolverKind = readOptionalString(row, 'resolver_kind')
  const resolverId = readOptionalString(row, 'resolver_id')
  const resolution = readOptionalString(row, 'resolution')
  return Object.freeze({
    id: readString(row, 'id'),
    leftMemoryId: readString(row, 'left_memory_id'),
    leftRevision: readNumber(row, 'left_revision'),
    rightMemoryId: readString(row, 'right_memory_id'),
    rightRevision: readNumber(row, 'right_revision'),
    status: readString(row, 'status') as MemoryConflict['status'],
    createdAt: readNumber(row, 'created_at'),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolverKind === undefined || resolverId === undefined
      ? {}
      : { resolver: Object.freeze({ kind: resolverKind as MemoryActor['kind'], id: resolverId }) }),
    ...(resolution === undefined ? {} : { resolution }),
  })
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

function normalizeNow(value: number | undefined): number {
  const now = value ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('dsh-memory now must be a non-negative safe integer')
  return now
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('dsh-memory query must be a string')
  const result = value.replace(/\r\n?/g, '\n').trim()
  if (result.length === 0 || result.length > 20_000) throw new Error('dsh-memory query length must be in [1, 20000]')
  return result
}

function normalizeIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`dsh-memory ${name} must be a string`)
  const result = value.trim()
  if (result.length === 0 || result.length > 500 || /[\u0000\r\n]/.test(result)) {
    throw new Error(`dsh-memory ${name} must be a non-empty single-line identifier`)
  }
  return result
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('dsh-memory reason must be a string')
  const result = value.replace(/\r\n?/g, '\n').trim()
  if (result.length < 3 || result.length > 2_000) throw new Error('dsh-memory reason length must be in [3, 2000]')
  return result
}

function normalizeOptionalNote(value: unknown): string {
  if (typeof value !== 'string') throw new Error('dsh-memory feedback.note must be a string')
  const result = value.replace(/\r\n?/g, '\n').trim()
  if (result.length === 0 || result.length > 2_000) throw new Error('dsh-memory feedback.note length must be in [1, 2000]')
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

function assertCandidateStatus(value: unknown): asserts value is MemoryCandidateStatus {
  if (value !== 'candidate' && value !== 'published' && value !== 'rejected' && value !== 'skipped') {
    throw new Error(`dsh-memory: unknown candidate status ${String(value)}`)
  }
}

function assertRecordStatus(value: unknown): asserts value is MemoryStatus {
  if (value !== 'active' && value !== 'conflicted' && value !== 'stale' && value !== 'archived' && value !== 'deleted') {
    throw new Error(`dsh-memory: unknown record status ${String(value)}`)
  }
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-memory ${name} must be a positive integer`)
  }
  return value
}

function assertNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
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

function blankRecordCounts(): Record<MemoryStatus, number> {
  return { active: 0, conflicted: 0, stale: 0, archived: 0, deleted: 0 }
}

function blankCandidateCounts(): Record<MemoryCandidateStatus, number> {
  return { candidate: 0, published: 0, rejected: 0, skipped: 0 }
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
  const byRecord = new Map(records.map(record => [record.memoryId, record]))
  const revisionKeys = new Set<string>()
  for (const revision of revisions) {
    const key = `${revision.memoryId}:${revision.revision}`
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
  }
  for (const record of records) {
    if (!revisionKeys.has(`${record.memoryId}:${record.revision}`)) {
      throw new Error(`dsh-memory restore-export: missing current revision for ${record.memoryId}`)
    }
  }
  const candidateIds = new Set<string>()
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) throw new Error(`dsh-memory restore-export: duplicate candidate ${candidate.id}`)
    candidateIds.add(candidate.id)
    if (candidate.targetMemoryId !== undefined && !byRecord.has(candidate.targetMemoryId)) {
      throw new Error(`dsh-memory restore-export: candidate ${candidate.id} references unknown target`)
    }
    if (candidate.exactDuplicateId !== undefined && !byRecord.has(candidate.exactDuplicateId)) {
      throw new Error(`dsh-memory restore-export: candidate ${candidate.id} references unknown duplicate`)
    }
    if (candidate.publishedMemoryId !== undefined && !byRecord.has(candidate.publishedMemoryId)) {
      throw new Error(`dsh-memory restore-export: candidate ${candidate.id} references unknown published memory`)
    }
  }
  for (const conflict of conflicts) {
    const left = byRecord.get(conflict.leftMemoryId)
    const right = byRecord.get(conflict.rightMemoryId)
    if (left === undefined || right === undefined) throw new Error(`dsh-memory restore-export: conflict references unknown record`)
    if (!revisionKeys.has(`${conflict.leftMemoryId}:${conflict.leftRevision}`)
      || !revisionKeys.has(`${conflict.rightMemoryId}:${conflict.rightRevision}`)) {
      throw new Error(`dsh-memory restore-export: conflict references unknown revision`)
    }
  }
  return Object.freeze({ format: 'dsh-memory-export', version: 1, exportedAt, records, revisions, candidates, conflicts })
}

function validateExportRecord(input: unknown, config: ResolvedConfig): MemoryRecord {
  const value = exportObject(input)
  const createdAt = exportTimestamp(value.createdAt, 'record.createdAt')
  const content = exportContent(value, config, createdAt)
  const memoryId = normalizeIdentifier(value.memoryId, 'record.memoryId')
  const revision = assertPositiveInteger(value.revision, 'record.revision')
  const operation = exportRevisionOperation(value.operation)
  const status = exportRecordStatus(value.status)
  const actor = normalizeActor(exportObject(value.actor) as unknown as MemoryActor)
  const contentHashValue = normalizeSha256(value.contentHash, 'record.contentHash')
  if (contentHash(content) !== contentHashValue) throw new Error(`dsh-memory restore-export: record hash mismatch ${memoryId}`)
  return Object.freeze({
    ...content, memoryId, revision, ...(value.parentRevision === undefined ? {} : { parentRevision: assertPositiveInteger(value.parentRevision, 'record.parentRevision') }),
    operation, actor, contentHash: contentHashValue, createdAt, status,
    updatedAt: exportTimestamp(value.updatedAt, 'record.updatedAt'),
    positiveFeedback: assertNonNegativeInteger(value.positiveFeedback, 'record.positiveFeedback'),
    negativeFeedback: assertNonNegativeInteger(value.negativeFeedback, 'record.negativeFeedback'),
    useCount: assertNonNegativeInteger(value.useCount, 'record.useCount'),
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: exportTimestamp(value.lastUsedAt, 'record.lastUsedAt') }),
  })
}

function validateExportRevision(input: unknown, config: ResolvedConfig): MemoryRevision {
  const value = exportObject(input)
  const createdAt = exportTimestamp(value.createdAt, 'revision.createdAt')
  const content = exportContent(value, config, createdAt)
  const memoryId = normalizeIdentifier(value.memoryId, 'revision.memoryId')
  const revision = assertPositiveInteger(value.revision, 'revision.revision')
  const contentHashValue = normalizeSha256(value.contentHash, 'revision.contentHash')
  if (contentHash(content) !== contentHashValue) throw new Error(`dsh-memory restore-export: revision hash mismatch ${memoryId}@${revision}`)
  return Object.freeze({
    ...content, memoryId, revision,
    ...(value.parentRevision === undefined ? {} : { parentRevision: assertPositiveInteger(value.parentRevision, 'revision.parentRevision') }),
    operation: exportRevisionOperation(value.operation), status: exportRecordStatus(value.status),
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
  return Object.freeze({
    id,
    ...(value.requestId === undefined ? {} : { requestId: normalizeIdentifier(value.requestId, 'candidate.requestId') }),
    operation: (() => { assertCandidateOperation(value.operation); return value.operation })(), status, content,
    actor: normalizeActor(exportObject(value.actor) as unknown as MemoryActor),
    ...(value.targetMemoryId === undefined ? {} : { targetMemoryId: normalizeIdentifier(value.targetMemoryId, 'candidate.targetMemoryId') }),
    ...(value.expectedRevision === undefined ? {} : { expectedRevision: assertPositiveInteger(value.expectedRevision, 'candidate.expectedRevision') }),
    ...(value.exactDuplicateId === undefined ? {} : { exactDuplicateId: normalizeIdentifier(value.exactDuplicateId, 'candidate.exactDuplicateId') }),
    contentHash: contentHashValue, createdAt: exportTimestamp(value.createdAt, 'candidate.createdAt'),
    ...(value.reviewedAt === undefined ? {} : { reviewedAt: exportTimestamp(value.reviewedAt, 'candidate.reviewedAt') }),
    ...(value.reviewer === undefined ? {} : { reviewer: normalizeActor(exportObject(value.reviewer) as unknown as MemoryActor) }),
    ...(value.decisionReason === undefined ? {} : { decisionReason: normalizeReason(value.decisionReason) }),
    ...(value.publishedMemoryId === undefined ? {} : { publishedMemoryId: normalizeIdentifier(value.publishedMemoryId, 'candidate.publishedMemoryId') }),
  })
}

function validateExportConflict(input: unknown): MemoryConflict {
  const value = exportObject(input)
  const status = value.status
  if (status !== 'open' && status !== 'resolved') throw new Error('dsh-memory restore-export: unknown conflict status')
  return Object.freeze({
    id: normalizeIdentifier(value.id, 'conflict.id'),
    leftMemoryId: normalizeIdentifier(value.leftMemoryId, 'conflict.leftMemoryId'),
    leftRevision: assertPositiveInteger(value.leftRevision, 'conflict.leftRevision'),
    rightMemoryId: normalizeIdentifier(value.rightMemoryId, 'conflict.rightMemoryId'),
    rightRevision: assertPositiveInteger(value.rightRevision, 'conflict.rightRevision'),
    status, createdAt: exportTimestamp(value.createdAt, 'conflict.createdAt'),
    ...(value.resolvedAt === undefined ? {} : { resolvedAt: exportTimestamp(value.resolvedAt, 'conflict.resolvedAt') }),
    ...(value.resolver === undefined ? {} : { resolver: normalizeActor(exportObject(value.resolver) as unknown as MemoryActor) }),
    ...(value.resolution === undefined ? {} : { resolution: normalizeReason(value.resolution) }),
  })
}

function exportContent(input: unknown, config: ResolvedConfig, now: number): MemoryContent {
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
  })
}

function exportObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('dsh-memory restore-export: expected object')
  return input as Record<string, unknown>
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

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EPERM' || error.code === 'EACCES')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function addStage(error: unknown, stage: string): Error {
  if (error instanceof Error && error.message.startsWith('dsh-memory')) return error
  return new Error(`dsh-memory ${stage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}

/** Stable privacy-safe content fingerprint used by tests and exports. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
