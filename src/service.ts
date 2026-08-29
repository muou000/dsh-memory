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
  MemoryHealth,
  MemoryProposalInput,
  MemoryRecord,
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

  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, 'memories')
    this.config = config
    this.log = ctx.logger('dsh-memory')
    this.store = new MemoryStore(config)
    this.projection = new MarkdownProjection(config)
    this.projectionState = config.markdownProjection ? 'degraded' : 'disabled'
    this.refreshProjection('startup')
    ctx.effect(() => () => this.store.close())
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
    const candidate = this.store.propose(input)
    this.refreshProjection('propose')
    return candidate
  }

  review(candidateId: string, input: MemoryReviewInput): MemoryCandidate {
    const candidate = this.store.review(candidateId, input)
    this.refreshProjection('review')
    return candidate
  }

  transition(memoryId: string, input: MemoryTransitionInput): MemoryRecord {
    const record = this.store.transition(memoryId, input)
    this.refreshProjection(input.action)
    return record
  }

  purge(memoryId: string, actor: MemoryActor, reason: string, now?: number): void {
    this.store.purge(memoryId, actor, reason, now)
    this.refreshProjection('purge')
  }

  get(memoryId: string, access: MemoryAccessContext, includeEvidence = true): MemoryRecord | undefined {
    return this.store.get(memoryId, access, includeEvidence)
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

  resolveConflict(conflictId: string, input: MemoryConflictResolutionInput): MemoryConflict {
    const conflict = this.store.resolveConflict(conflictId, input)
    this.refreshProjection('resolve-conflict')
    return conflict
  }

  search(query: string, access: MemoryAccessContext, options?: MemorySearchOptions): MemorySearchResult {
    return this.store.search(query, access, options)
  }

  recordRetrieval(input: MemoryRetrievalLogInput): void {
    this.store.recordRetrieval(input)
  }

  feedback(input: MemoryFeedbackInput): void {
    this.store.feedback(input)
    this.refreshProjection('feedback')
  }

  stats(): MemoryStats {
    return this.store.stats()
  }

  export(now?: number): MemoryExport {
    return this.store.export(now)
  }

  restoreExport(value: unknown): void {
    this.store.restoreExport(value)
    this.refreshProjection('restore-export')
  }

  backup(destination: string): Promise<number> {
    return createDatabaseBackup(this.store.database, destination)
  }

  rebuild(): void {
    this.store.rebuildFts()
    this.refreshProjection('rebuild')
  }

  private refreshProjection(stage: string): void {
    if (!this.config.markdownProjection || this.config.readOnly) {
      this.projectionState = 'disabled'
      return
    }
    try {
      this.projection.rebuild(this.store)
      this.projectionState = 'ready'
      this.lastProjectionAt = Date.now()
      this.lastProjectionError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.projectionState = 'degraded'
      this.lastProjectionError = `stage=${stage}: ${message}`
      this.log.error('projection failed at %s; canonical store remains committed: %s', stage, message)
    }
  }
}
