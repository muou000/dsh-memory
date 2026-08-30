import { Context, Service } from '@deepseek-ai/cordis'
import type { Logger } from '@deepseek-ai/cordis'
import { createDatabaseBackup } from './backup.ts'
import type { ResolvedConfig } from './config.ts'
import { MarkdownProjection } from './projection.ts'
import { MemoryStore } from './store.ts'
import type {
  MemoryAccessContext,
  MemoryActor,
  MemoryCandidate,
  MemoryCandidateStatus,
  MemoryConflict,
  MemoryConflictResolutionInput,
  MemoryExport,
  MemoryFeedbackInput,
  MemoryFeedbackRecord,
  MemoryHealth,
  MemoryAuditRecord,
  MemoryMaintenanceOptions,
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
  MemorySearchOptions,
  MemorySearchResult,
  MemoryStats,
  MemoryStatus,
  MemoryTransitionInput,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memories: MemoryService
  }
}

/** Public governed memory capability backed by the configured provider. */
export class MemoryService extends Service {
  readonly config: ResolvedConfig
  readonly store: MemoryStore
  readonly projection: MarkdownProjection

  private readonly log: Logger
  private projectionState: 'ready' | 'disabled' | 'degraded'
  private lastProjectionAt: number | undefined
  private lastProjectionError: string | undefined
  private projectionFailureCount = 0
  private projectionFullRebuildCount = 0
  private projectionIncrementalUpdateCount = 0
  private projectionFilesWritten = 0

  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, 'memories')
    this.config = config
    this.log = ctx.logger('dsh-memory')
    try {
      this.store = new MemoryStore(config)
    } catch (error) {
      this.log.error('stage=open outcome=error code=%s', classifyMemoryError(error))
      throw error
    }
    // Register ownership immediately after opening the canonical resource so
    // a future initialization failure cannot strand the database handle or
    // writer lock. The disposer is idempotent in MemoryStore.
    ctx.effect(() => () => this.store.close(), 'dsh-memory.store.close')
    this.projection = new MarkdownProjection(config)
    this.projectionState = config.markdownProjection ? 'degraded' : 'disabled'
    this.refreshProjection('startup')
  }

  get writable(): boolean {
    return !this.config.readOnly
  }

  get health(): MemoryHealth {
    return Object.freeze({
      ...this.store.health,
      projectionState: this.projectionState,
      ...(this.lastProjectionAt === undefined ? {} : { lastProjectionAt: this.lastProjectionAt }),
      ...(this.lastProjectionError === undefined ? {} : { lastProjectionError: this.lastProjectionError }),
    })
  }

  propose(input: MemoryProposalInput): MemoryCandidate {
    const observed = this.observe('propose', () => this.store.propose(input))
    const candidate = observed.value
    this.log.info(
      'stage=propose outcome=%s candidate_id=%s operation=%s similar_count=%d duration_ms=%f',
      candidate.status,
      candidate.id,
      candidate.operation,
      candidate.similarMemoryIds.length,
      observed.durationMs,
    )
    this.refreshProjection('propose', [])
    return candidate
  }

  review(candidateId: string, input: MemoryReviewInput): MemoryCandidate {
    const observed = this.observe('review', () => this.store.review(candidateId, input))
    const candidate = observed.value
    this.log.info(
      'stage=review outcome=%s candidate_id=%s published_memory_id=%s duration_ms=%f',
      candidate.status,
      candidate.id,
      candidate.publishedMemoryId ?? 'none',
      observed.durationMs,
    )
    this.refreshProjection('review', [
      ...(candidate.publishedMemoryId === undefined ? [] : [candidate.publishedMemoryId]),
      ...(candidate.targetMemoryId === undefined ? [] : [candidate.targetMemoryId]),
      ...candidate.similarMemoryIds,
    ])
    return candidate
  }

  transition(memoryId: string, input: MemoryTransitionInput): MemoryRecord {
    const observed = this.observe(input.action, () => this.store.transition(memoryId, input))
    const record = observed.value
    this.log.info(
      'stage=%s outcome=success memory_id=%s revision=%d status=%s duration_ms=%f',
      input.action,
      record.memoryId,
      record.revision,
      record.status,
      observed.durationMs,
    )
    this.refreshProjection(input.action, [record.memoryId])
    return record
  }

  purge(memoryId: string, actor: MemoryActor, reason: string, now?: number): void {
    const observed = this.observe('purge', () => this.store.purge(memoryId, actor, reason, now))
    this.log.info('stage=purge outcome=success memory_id=%s duration_ms=%f', memoryId, observed.durationMs)
    this.refreshProjection('purge', [memoryId])
  }

  get(memoryId: string, access: MemoryAccessContext, includeEvidence = true, includeInactive = false, now?: number): MemoryRecord | undefined {
    return this.store.get(memoryId, access, includeEvidence, includeInactive, now)
  }

  getCandidate(candidateId: string): MemoryCandidate | undefined {
    return this.store.getCandidate(candidateId)
  }

  listCandidates(status: MemoryCandidateStatus = 'candidate'): readonly MemoryCandidate[] {
    return this.store.listCandidates(status)
  }

  listRecords(statuses?: readonly MemoryStatus[]): readonly MemoryRecord[] {
    return this.store.listRecords(statuses)
  }

  listRevisions(memoryId?: string): readonly MemoryRevision[] {
    return this.store.listRevisions(memoryId)
  }

  listConflicts(status: 'open' | 'resolved' = 'open'): readonly MemoryConflict[] {
    return this.store.listConflicts(status)
  }

  listRetrievals(limit?: number): readonly MemoryRetrievalLog[] {
    return this.store.listRetrievals(limit)
  }

  listFeedback(memoryId?: string): readonly MemoryFeedbackRecord[] {
    return this.store.listFeedback(memoryId)
  }

  listAudit(limit?: number): readonly MemoryAuditRecord[] {
    return this.store.listAudit(limit)
  }

  resolveConflict(conflictId: string, input: MemoryConflictResolutionInput): MemoryConflict {
    const observed = this.observe('resolve-conflict', () => this.store.resolveConflict(conflictId, input))
    const conflict = observed.value
    this.log.info(
      'stage=resolve-conflict outcome=%s conflict_id=%s action=%s duration_ms=%f',
      conflict.status,
      conflict.id,
      input.action,
      observed.durationMs,
    )
    this.refreshProjection('resolve-conflict', [conflict.leftMemoryId, conflict.rightMemoryId])
    return conflict
  }

  search(query: string, access: MemoryAccessContext, options?: MemorySearchOptions): MemorySearchResult {
    const observed = this.observe('search', () => this.store.search(query, access, options))
    this.log.debug(
      'stage=search outcome=success query_hash=%s candidate_count=%d hit_count=%d duration_ms=%f',
      observed.value.queryHash,
      observed.value.candidateCount,
      observed.value.hits.length,
      observed.value.durationMs,
    )
    return observed.value
  }

  recordRetrieval(input: MemoryRetrievalLogInput): void {
    const observed = this.observe('record-retrieval', () => this.store.recordRetrieval(input))
    this.log.debug(
      'stage=record-retrieval outcome=success retrieval_id=%s candidate_count=%d selected_count=%d estimated_tokens=%d duration_ms=%f',
      input.id,
      input.candidateCount,
      input.selected.length,
      input.estimatedTokens,
      observed.durationMs,
    )
  }

  recordRead(input: MemoryReadInput): void {
    const observed = this.observe('record-read', () => this.store.recordRead(input))
    this.log.debug(
      'stage=record-read outcome=success memory_id=%s revision=%d retrieval_id=%s duration_ms=%f',
      input.memoryId,
      input.revision,
      input.retrievalId ?? 'none',
      observed.durationMs,
    )
  }

  feedback(input: MemoryFeedbackInput): void {
    const observed = this.observe('feedback', () => this.store.feedback(input))
    this.log.info(
      'stage=feedback outcome=success memory_id=%s revision=%d kind=%s retrieval_id=%s duration_ms=%f',
      input.memoryId,
      input.revision,
      input.kind,
      input.retrievalId ?? 'none',
      observed.durationMs,
    )
    this.refreshProjection('feedback', [input.memoryId])
  }

  stats(): MemoryStats {
    return this.store.stats()
  }

  maintenance(options?: MemoryMaintenanceOptions): MemoryMaintenanceResult {
    const observed = this.observe('maintenance', () => this.store.maintenance(options))
    this.log.debug(
      'stage=maintenance outcome=success scanned=%d nominations=%d duration_ms=%f',
      observed.value.scanned,
      observed.value.nominations.length,
      observed.durationMs,
    )
    return observed.value
  }

  prune(actor: MemoryActor, reason: string, now?: number): MemoryRetentionResult {
    const observed = this.observe('prune', () => this.store.prune(actor, reason, now))
    const result = observed.value
    this.log.info(
      'stage=prune outcome=success candidates=%d retrievals=%d feedback=%d audit=%d duration_ms=%f',
      result.reviewedCandidatesDeleted,
      result.retrievalsDeleted,
      result.feedbackDeleted,
      result.auditRowsDeleted,
      observed.durationMs,
    )
    this.refreshProjection('prune', result.feedbackDeleted > 0 ? undefined : [])
    return result
  }

  metrics(now?: number): MemoryMetrics {
    const metrics = this.store.metrics(now)
    return Object.freeze({
      ...metrics,
      projectionFailures: this.projectionFailureCount,
      projectionFullRebuilds: this.projectionFullRebuildCount,
      projectionIncrementalUpdates: this.projectionIncrementalUpdateCount,
      projectionFilesWritten: this.projectionFilesWritten,
    })
  }

  export(now?: number): MemoryExport {
    return this.store.export(now)
  }

  restoreExport(value: unknown): void {
    const observed = this.observe('restore-export', () => this.store.restoreExport(value))
    const stats = this.store.stats()
    this.log.info(
      'stage=restore-export outcome=success active=%d candidates=%d duration_ms=%f',
      stats.recordsByStatus.active,
      Object.values(stats.candidatesByStatus).reduce((sum, count) => sum + count, 0),
      observed.durationMs,
    )
    this.refreshProjection('restore-export')
  }

  backup(destination: string): Promise<number> {
    return createDatabaseBackup(this.store.database, destination)
  }

  rebuild(): void {
    const observed = this.observe('rebuild-index', () => this.store.rebuildFts())
    this.log.info('stage=rebuild-index outcome=success duration_ms=%f', observed.durationMs)
    this.refreshProjection('rebuild')
  }

  private observe<T>(stage: string, operation: () => T): { readonly value: T; readonly durationMs: number } {
    const started = performance.now()
    try {
      return { value: operation(), durationMs: performance.now() - started }
    } catch (error) {
      this.log.error(
        'stage=%s outcome=error code=%s duration_ms=%f',
        stage,
        classifyMemoryError(error),
        performance.now() - started,
      )
      throw error
    }
  }

  private refreshProjection(stage: string, recordIds?: readonly string[]): void {
    if (!this.config.markdownProjection || this.config.readOnly) {
      this.projectionState = 'disabled'
      return
    }
    const started = performance.now()
    try {
      const publication = this.projectionState === 'ready' && recordIds !== undefined
        ? this.projection.refresh(this.store, recordIds)
        : this.projection.rebuild(this.store)
      if (publication.mode === 'full') this.projectionFullRebuildCount += 1
      else this.projectionIncrementalUpdateCount += 1
      this.projectionFilesWritten += publication.writtenFiles
      this.projectionState = 'ready'
      this.lastProjectionAt = Date.now()
      this.lastProjectionError = undefined
      this.log.debug(
        'stage=projection outcome=ready trigger=%s mode=%s written_files=%d reused_files=%d removed_files=%d total_files=%d duration_ms=%f',
        stage,
        publication.mode,
        publication.writtenFiles,
        publication.reusedFiles,
        publication.removedFiles,
        publication.totalFiles,
        performance.now() - started,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.projectionState = 'degraded'
      this.projectionFailureCount += 1
      this.lastProjectionError = `stage=${stage}: ${message}`
      this.log.error(
        'stage=projection outcome=degraded trigger=%s code=write_failed failure_count=%d duration_ms=%f',
        stage,
        this.projectionFailureCount,
        performance.now() - started,
      )
    }
  }
}

function classifyMemoryError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('secret-like')) return 'secret_rejected'
  if (message.includes('optimistic revision mismatch')) return 'revision_conflict'
  if (message.includes('read-only')) return 'read_only'
  if (message.includes('another writer')) return 'writer_locked'
  if (message.includes('newer than supported') || message.includes('schema')) return 'schema_incompatible'
  if (message.includes('quick_check') || message.includes('integrity')) return 'integrity_failed'
  if (message.includes('unknown memory') || message.includes('unknown candidate') || message.includes('unknown conflict')) return 'not_found'
  if (message.includes('must') || message.includes('invalid') || message.includes('unknown action') || message.includes('length')) {
    return 'validation_failed'
  }
  return 'internal_error'
}
