import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { CREATE_SCHEMA_SQL } from '../src/schema.ts'
import { queryHash } from '../src/content.ts'
import { MemoryStore } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, proposer, reviewer, temporaryMemoryHome, workspaceAlpha } from './helpers.ts'

const homes: TemporaryMemoryHome[] = []
const stores: MemoryStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const home of homes.splice(0)) home.cleanup()
})

function setup(overrides: Parameters<typeof temporaryMemoryHome>[0] = {}): MemoryStore {
  const home = temporaryMemoryHome({ markdownProjection: false, ...overrides })
  homes.push(home)
  const store = new MemoryStore(home.config)
  stores.push(store)
  return store
}

function publish(store: MemoryStore, content = draft(), now = 1_000): string {
  const candidate = store.propose({ content, actor: proposer, now })
  store.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Operations fixture verified.', now: now + 1 })
  return store.listRecords(['active', 'stale', 'archived', 'conflicted'])[0]!.memoryId
}

describe('operational accounting and maintenance', () => {
  it('reports eligible candidates separately from the limited hit list', () => {
    const store = setup()
    publish(store, draft({ subject: 'Queue telemetry report alpha' }), 1_000)
    publish(store, draft({ subject: 'Queue telemetry report beta' }), 2_000)
    const result = store.search('queue telemetry report', { workspace: workspaceAlpha }, { limit: 1, now: 3_000 })
    expect(result.candidateCount).toBe(2)
    expect(result.hits).toHaveLength(1)
  })

  it('rejects null operational payloads with stage-specific validation errors', () => {
    const store = setup()
    expect(() => store.recordRetrieval(null as never)).toThrow('record-retrieval must be an object')
    expect(() => store.recordRead(null as never)).toThrow('record-read must be an object')
    expect(() => store.feedback(null as never)).toThrow('feedback must be an object')
    expect(() => store.maintenance(null as never)).toThrow('maintenance must be an object')
    expect(() => store.search('query', { workspace: workspaceAlpha }, null as never)).toThrow('search options must be an object')
    expect(() => store.get('missing', { workspace: workspaceAlpha }, 'yes' as never)).toThrow('includeEvidence')
    expect(() => store.get('missing', { workspace: workspaceAlpha }, true, 'yes' as never)).toThrow('includeInactive')
    expect(() => store.transition('missing', {
      action: 'delete', expectedRevision: '1' as never, actor: reviewer, reason: 'bad revision',
    })).toThrow('expectedRevision must be a positive integer')
  })

  it('treats a replayed retrieval accounting event as idempotent', () => {
    const store = setup()
    const id = publish(store)
    const record = store.listRecords(['active'])[0]!
    const input = {
      id: 'replayed-retrieval',
      queryHash: queryHash('queue telemetry'),
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 10,
      durationMs: 1,
      now: 3_000,
    } as const
    store.recordRetrieval(input)
    store.recordRetrieval(input)
    expect(store.listRetrievals()).toHaveLength(1)
    expect(store.listRecords(['active'])[0]?.useCount).toBe(1)
    expect(() => store.recordRetrieval({ ...input, estimatedTokens: 11 })).toThrow('different data')
    expect(() => store.recordRetrieval({
      ...input,
      durationMs: 999,
      selected: [{ memoryId: id, revision: record.revision, score: 99 }],
      now: 99_000,
    })).not.toThrow()
    const current = store.listRecords(['active'])[0]!
    store.transition(current.memoryId, {
      action: 'invalidate', expectedRevision: current.revision,
      actor: reviewer, reason: 'Replay fixture became stale.', now: 4_000,
    })
    expect(() => store.recordRetrieval(input)).not.toThrow()
    expect(store.listRetrievals()).toHaveLength(1)
  })

  it('rejects accounting timestamps that precede the current revision head', () => {
    const store = setup()
    const id = publish(store, draft(), 1_000)
    const record = store.listRecords(['active'])[0]!
    expect(record.updatedAt).toBe(1_001)
    expect(() => store.recordRetrieval({
      id: 'too-early-retrieval',
      queryHash: queryHash('queue telemetry'),
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 1,
      durationMs: 1,
      now: 1_000,
    })).toThrow('timestamp precedes')
    expect(() => store.recordRead({
      memoryId: id, revision: record.revision, actor: reviewer, now: 1_000,
    })).toThrow('timestamp precedes')
    expect(() => store.feedback({
      memoryId: id, revision: record.revision, kind: 'helpful', actor: reviewer, now: 1_000,
    })).toThrow('timestamp precedes')
  })

  it('creates deterministic maintenance nominations without changing lifecycle state', () => {
    const store = setup({
      maintenanceExpiringWithinHours: 24,
      maintenanceNegativeFeedbackRatio: 0.5,
      maintenanceMinimumFeedbackCount: 1,
      maintenanceUnusedAfterDays: 1,
    })
    const id = publish(store, draft({ expiresAt: 10_000 }), 1_000)
    const record = store.listRecords(['active'])[0]!
    store.feedback({ memoryId: id, revision: record.revision, kind: 'harmful', actor: reviewer, now: 2_000 })
    const before = store.listRecords(['active'])[0]!
    const result = store.maintenance({ now: 9_000, limit: 10 })
    expect(result.scanned).toBe(1)
    expect(result.nominations[0]?.record.memoryId).toBe(id)
    expect(result.nominations[0]?.reasons).toEqual(['expiring', 'negative-feedback'])
    expect(store.listRecords(['active'])[0]).toMatchObject({ memoryId: id, revision: before.revision, status: 'active' })
  })

  it('rejects secret-like governance reasons and feedback without partial writes', () => {
    const store = setup()
    const candidate = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    expect(() => store.review(candidate.id, {
      action: 'publish', actor: reviewer, reason: 'api_key=abcdefghijklmnop', now: 2_000,
    })).toThrow('secret-like')
    expect(store.getCandidate(candidate.id)?.status).toBe('candidate')
    expect(store.listRecords()).toHaveLength(0)
    store.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Verified without secrets.', now: 3_000 })
    const record = store.listRecords()[0]!
    expect(() => store.feedback({
      memoryId: record.memoryId,
      revision: record.revision,
      kind: 'harmful',
      actor: reviewer,
      note: 'access_token=abcdefghijklmnop',
      now: 4_000,
    })).toThrow('secret-like')
    expect(store.listFeedback()).toHaveLength(0)
    expect(store.listRecords()[0]?.negativeFeedback).toBe(0)
  })

  it('applies explicit retention without deleting pending candidates or canonical records', () => {
    const store = setup({
      logQueryText: true,
      reviewedCandidateRetentionDays: 1,
      queryTextRetentionDays: 1,
      retrievalRetentionDays: 1,
      feedbackRetentionDays: 1,
      auditRetentionDays: 1,
    })
    const id = publish(store)
    const record = store.listRecords()[0]!
    store.recordRetrieval({
      id: 'old-retrieval',
      queryHash: queryHash('queue telemetry'),
      queryText: 'queue telemetry',
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 10,
      durationMs: 2,
      now: 3_000,
    })
    store.feedback({
      memoryId: id, revision: record.revision, retrievalId: 'old-retrieval',
      kind: 'harmful', actor: reviewer, now: 4_000,
    })
    store.recordRead({
      memoryId: id, revision: record.revision, retrievalId: 'old-retrieval',
      actor: reviewer, now: 5_000,
    })
    expect(store.metrics(6_000).drillDownCount).toBe(1)
    expect(() => store.recordRead({
      memoryId: id, revision: record.revision, retrievalId: 'missing-retrieval',
      actor: reviewer, now: 6_000,
    })).toThrow('unknown retrieval')
    const pending = store.propose({
      content: draft({ subject: 'A distinct pending retention candidate' }),
      actor: proposer,
      now: 5_000,
    })
    const result = store.prune(reviewer, 'Apply configured privacy retention.', 2 * 86_400_000)
    expect(result).toMatchObject({
      reviewedCandidatesDeleted: 1,
      retrievalsDeleted: 1,
      feedbackDeleted: 1,
    })
    expect(store.getCandidate(pending.id)?.status).toBe('candidate')
    expect(store.listRecords()).toHaveLength(1)
    expect(store.listRecords()[0]).toMatchObject({ positiveFeedback: 0, negativeFeedback: 0 })
    expect(store.listRetrievals()).toHaveLength(0)
    expect(store.listFeedback()).toHaveLength(0)
    expect(store.listAudit().at(-1)?.action).toBe('retention.prune')
  })
})

describe('portable telemetry and schema recovery', () => {
  it('rolls back every publication row when the audit write fails', () => {
    const store = setup()
    const candidate = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.database.exec(`
      CREATE TRIGGER fail_publish_audit
      BEFORE INSERT ON memory_audit
      WHEN NEW.action = 'candidate.publish'
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;
    `)
    expect(() => store.review(candidate.id, {
      action: 'publish', actor: reviewer, reason: 'This transaction must roll back.', now: 2_000,
    })).toThrow('injected audit failure')
    expect(store.listRecords()).toHaveLength(0)
    expect(store.listRevisions()).toHaveLength(0)
    expect(store.getCandidate(candidate.id)?.status).toBe('candidate')
    store.database.exec('DROP TRIGGER fail_publish_audit')
    expect(store.review(candidate.id, {
      action: 'publish', actor: reviewer, reason: 'Retry after fault removal.', now: 3_000,
    }).status).toBe('published')
  })

  it('round-trips retrieval, feedback, and audit rows and accepts an older export', () => {
    const source = setup()
    const id = publish(source)
    const record = source.listRecords(['active'])[0]!
    source.recordRetrieval({
      id: 'retrieval-1',
      queryHash: queryHash('queue telemetry'),
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1.25 }],
      tokenBudget: 400,
      estimatedTokens: 35,
      durationMs: 4.5,
      sessionId: 'session-alpha',
      turn: 2,
      now: 3_000,
    })
    source.feedback({ id: 'feedback-1', memoryId: id, revision: record.revision, kind: 'helpful', actor: reviewer, retrievalId: 'retrieval-1', now: 4_000 })
    source.feedback({ id: 'feedback-1', memoryId: id, revision: record.revision, kind: 'helpful', actor: reviewer, retrievalId: 'retrieval-1', now: 99_000 })
    const exported = source.export(5_000)
    expect(exported.retrievals).toHaveLength(1)
    expect(exported.feedback).toHaveLength(1)
    expect(exported.audit.length).toBeGreaterThan(0)

    const targetHome = temporaryMemoryHome({ markdownProjection: false })
    homes.push(targetHome)
    const target = new MemoryStore(targetHome.config)
    stores.push(target)
    target.restoreExport(exported)
    expect(target.listRetrievals()).toEqual(exported.retrievals)
    expect(target.listFeedback()).toEqual(exported.feedback)
    expect(target.listAudit().slice(0, exported.audit.length)).toEqual(exported.audit)

    const oldExport: unknown = structuredClone(exported)
    delete (oldExport as { retrievals?: unknown }).retrievals
    delete (oldExport as { feedback?: unknown }).feedback
    delete (oldExport as { audit?: unknown }).audit
    const oldTargetHome = temporaryMemoryHome({ markdownProjection: false })
    homes.push(oldTargetHome)
    const oldTarget = new MemoryStore(oldTargetHome.config)
    stores.push(oldTarget)
    oldTarget.restoreExport(oldExport)
    expect(oldTarget.listRecords()).toHaveLength(1)
    expect(oldTarget.listRecords()[0]?.positiveFeedback).toBe(0)
    oldTarget.close()
    stores.splice(stores.indexOf(oldTarget), 1)
    const reopened = new MemoryStore(oldTargetHome.config)
    stores.push(reopened)
    expect(reopened.listRecords()[0]?.negativeFeedback).toBe(0)
  })

  it('keeps telemetry rows but suppresses sensitive opt-in query text', () => {
    const store = setup({ logQueryText: true })
    const id = publish(store)
    const record = store.listRecords(['active'])[0]!
    store.recordRetrieval({
      id: 'safe-retrieval',
      queryHash: queryHash('api_key=super-secret-value'),
      queryText: 'api_key=super-secret-value',
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 10,
      durationMs: 1,
      now: 3_000,
    })
    expect(store.listRetrievals()[0]?.id).toBe('safe-retrieval')
    expect(store.listRetrievals()[0]?.queryText).toBeUndefined()
  })

  it('does not import opted-in query text into a default hash-only store', () => {
    const sourceHome = temporaryMemoryHome({ markdownProjection: false, logQueryText: true })
    const targetHome = temporaryMemoryHome({ markdownProjection: false, logQueryText: false })
    homes.push(sourceHome, targetHome)
    const source = new MemoryStore(sourceHome.config)
    const target = new MemoryStore(targetHome.config)
    stores.push(source, target)
    const id = publish(source)
    const record = source.listRecords(['active'])[0]!
    source.recordRetrieval({
      id: 'opted-in-query',
      queryHash: queryHash('private project query'),
      queryText: 'private project query',
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 10,
      durationMs: 1,
      now: 3_000,
    })
    target.restoreExport(source.export(4_000))
    expect(target.listRetrievals()[0]?.queryText).toBeUndefined()
  })

  it('scrubs purged retrieval references so the remaining store stays portable', () => {
    const store = setup({ logQueryText: true })
    const id = publish(store)
    const record = store.listRecords(['active'])[0]!
    store.recordRetrieval({
      id: 'purged-retrieval',
      queryHash: queryHash('queue telemetry'),
      queryText: 'queue telemetry',
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 10,
      durationMs: 1,
      now: 3_000,
    })
    const deleted = store.transition(id, {
      action: 'delete', expectedRevision: record.revision,
      actor: reviewer, reason: 'Approved privacy deletion.', now: 4_000,
    })
    store.purge(id, reviewer, 'Approved privacy purge.', 5_000)

    expect(deleted.status).toBe('deleted')
    expect(store.listRetrievals()[0]).toMatchObject({ id: 'purged-retrieval', selected: [] })
    expect(store.listRetrievals()[0]?.queryText).toBeUndefined()
    const exported = store.export(6_000)
    const target = setup()
    expect(() => target.restoreExport(exported)).not.toThrow()
    expect(target.listRetrievals()[0]?.selected).toEqual([])
  })

  it('exports an expired working record as historical data without reviving it', () => {
    const store = setup()
    const candidate = store.propose({
      content: draft({
        kind: 'working',
        scope: { type: 'session', key: 'session-working' },
        expiresAt: 2_000,
      }),
      actor: proposer,
      now: 1_000,
    })
    store.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Working fixture verified.', now: 1_500 })
    const record = store.listRecords(['active'])[0]!
    expect(store.get(record.memoryId, { session: 'session-working' }, true, false, 3_000)).toBeUndefined()
    const exported = store.export(3_000)
    expect(exported.records[0]?.kind).toBe('working')
    const target = setup()
    expect(() => target.restoreExport(exported)).not.toThrow()
    expect(target.get(record.memoryId, { session: 'session-working' }, true, false, 3_000)).toBeUndefined()
  })

  it('allows explicit lifecycle cleanup after a working record expires', () => {
    const store = setup()
    const candidate = store.propose({
      content: draft({
        kind: 'working',
        scope: { type: 'session', key: 'session-cleanup' },
        expiresAt: 2_000,
      }),
      actor: proposer,
      now: 1_000,
    })
    store.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Cleanup fixture verified.', now: 1_500 })
    const record = store.listRecords(['active'])[0]!
    const invalidated = store.transition(record.memoryId, {
      action: 'invalidate', expectedRevision: record.revision, actor: reviewer,
      reason: 'Expired working context is no longer useful.', now: 3_000,
    })
    expect(invalidated.status).toBe('stale')
    const target = setup()
    expect(() => target.restoreExport(store.export(3_500))).not.toThrow()
    expect(target.listRecords(['stale'])[0]?.status).toBe('stale')
  })

  it('fails closed when conflict or revision history is tampered with', () => {
    const store = setup()
    const candidate = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Integrity fixture.', now: 2_000 })
    const record = store.listRecords(['active'])[0]!
    store.database.prepare('UPDATE memory_revisions SET created_at = 0 WHERE memory_id = ? AND revision = 1').run(record.memoryId)
    expect(() => store.listRecords(['active'])).toThrow('updated_at')

    const conflictStore = setup()
    const left = conflictStore.propose({ content: draft(), actor: proposer, now: 1_000 })
    conflictStore.review(left.id, { action: 'publish', actor: reviewer, reason: 'Conflict fixture.', now: 2_000 })
    const leftRecord = conflictStore.listRecords(['active'])[0]!
    const right = conflictStore.propose({
      operation: 'contradict', targetMemoryId: leftRecord.memoryId, expectedRevision: leftRecord.revision,
      content: draft({ action: 'Contradictory fixture.' }), actor: proposer, now: 3_000,
    })
    conflictStore.review(right.id, { action: 'publish', actor: reviewer, reason: 'Keep conflict open.', now: 4_000 })
    const conflict = conflictStore.listConflicts('open')[0]!
    conflictStore.database.prepare("UPDATE memory_conflicts SET status = 'resolved' WHERE id = ?").run(conflict.id)
    expect(() => conflictStore.listConflicts('resolved')).toThrow('incomplete resolution')

    const sensitive = setup()
    const sensitiveCandidate = sensitive.propose({ content: draft(), actor: proposer, now: 1_000 })
    sensitive.database.prepare('UPDATE memory_candidates SET decision_reason = ? WHERE id = ?')
      .run('password=super-secret-value', sensitiveCandidate.id)
    expect(() => sensitive.getCandidate(sensitiveCandidate.id)).toThrow('sensitive content')
  })

  it('fails closed when a revision loses its required evidence rows', () => {
    const store = setup()
    const id = publish(store)
    store.database.prepare('DELETE FROM memory_evidence WHERE memory_id = ? AND revision = 1').run(id)
    expect(() => store.listRecords(['active'])).toThrow('must contain 1 to 50 evidence references')
  })

  it('repairs a damaged derived FTS index on writable startup and rejects it read-only', () => {
    const home = temporaryMemoryHome({ markdownProjection: false })
    homes.push(home)
    const writer = new MemoryStore(home.config)
    stores.push(writer)
    const id = publish(writer)
    writer.database.prepare('UPDATE memory_fts SET subject = ? WHERE memory_id = ?').run('tampered index text', id)
    writer.close()
    stores.splice(stores.indexOf(writer), 1)

    const repaired = new MemoryStore(home.config)
    stores.push(repaired)
    expect(repaired.search('stop hook', { workspace: workspaceAlpha, includeGlobal: false }).hits)
      .toHaveLength(1)
    expect(repaired.listAudit().some(item => item.action === 'index.rebuild')).toBe(true)
    repaired.close()
    stores.splice(stores.indexOf(repaired), 1)

    const tamper = new DatabaseSync(home.config.storagePath)
    tamper.exec('DELETE FROM memory_fts')
    tamper.close()
    expect(() => new MemoryStore({ ...home.config, readOnly: true })).toThrow('derived full-text index')
  })

  it('rejects portable telemetry that points at an unknown memory revision', () => {
    const source = setup()
    const id = publish(source)
    const record = source.listRecords(['active'])[0]!
    source.recordRetrieval({
      id: 'retrieval-reference',
      queryHash: queryHash('queue telemetry'),
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: id, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 10,
      durationMs: 1,
      now: 3_000,
    })
    const corrupted = structuredClone(source.export(4_000)) as unknown as { retrievals: Array<{ selected: Array<{ memoryId: string }> }> }
    corrupted.retrievals[0]!.selected[0]!.memoryId = 'missing-memory'
    const targetHome = temporaryMemoryHome({ markdownProjection: false })
    homes.push(targetHome)
    const target = new MemoryStore(targetHome.config)
    stores.push(target)
    expect(() => target.restoreExport(corrupted)).toThrow('unknown revision')
    expect(target.listRecords()).toHaveLength(0)
  })

  it('rejects a portable published candidate whose memory reference is semantically wrong', () => {
    const source = setup()
    const first = source.propose({ content: draft(), actor: proposer, now: 1_000 })
    source.review(first.id, { action: 'publish', actor: reviewer, reason: 'First publication verified.', now: 2_000 })
    const second = source.propose({
      content: draft({ subject: 'A distinct second knowledge record' }), actor: proposer, now: 3_000,
    })
    source.review(second.id, { action: 'publish', actor: reviewer, reason: 'Second publication verified.', now: 4_000 })
    const records = source.listRecords(['active'])
    const firstRecord = records.find(record => record.subject !== 'A distinct second knowledge record')!
    const secondRecord = records.find(record => record.memoryId !== firstRecord.memoryId)!
    const corrupted = structuredClone(source.export(5_000)) as unknown as {
      candidates: Array<{ status: string; publishedMemoryId?: string }>
    }
    const published = corrupted.candidates.find(candidate => candidate.status === 'published')!
    published.publishedMemoryId = secondRecord.memoryId

    const targetHome = temporaryMemoryHome({ markdownProjection: false })
    homes.push(targetHome)
    const target = new MemoryStore(targetHome.config)
    stores.push(target)
    expect(() => target.restoreExport(corrupted)).toThrow('published reference')
    expect(target.listRecords()).toHaveLength(0)
  })

  it('rejects a resolved conflict whose resolution timestamp is after its record heads', () => {
    const store = setup()
    const home = homes.at(-1)!
    const original = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(original.id, { action: 'publish', actor: reviewer, reason: 'Conflict source verified.', now: 2_000 })
    const target = store.listRecords(['active'])[0]!
    const contradiction = store.propose({
      operation: 'contradict', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content: draft({ action: 'Use the alternate verified behavior.' }), actor: proposer, now: 3_000,
    })
    store.review(contradiction.id, { action: 'publish', actor: reviewer, reason: 'Keep both claims for review.', now: 4_000 })
    const open = store.listConflicts('open')[0]!
    store.resolveConflict(open.id, {
      action: 'keep-left', actor: reviewer, reason: 'The original claim wins.', now: 5_000,
    })
    store.database.prepare('UPDATE memory_conflicts SET resolved_at = ? WHERE id = ?').run(6_000, open.id)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    expect(() => new MemoryStore(home.config)).toThrow('inconsistent resolution timing')
  })

  it('migrates a v1 store forward and rejects an unknown newer version', () => {
    const home = temporaryMemoryHome({ markdownProjection: false })
    homes.push(home)
    expect(existsSync(home.config.storagePath)).toBe(false)
    mkdirSync(join(home.config.storagePath, '..'), { recursive: true })
    const legacy = new DatabaseSync(home.config.storagePath)
    legacy.exec(CREATE_SCHEMA_SQL)
    legacy.exec('DROP TABLE memory_meta; ALTER TABLE memory_candidates DROP COLUMN similar_memory_ids_json; PRAGMA user_version = 1')
    legacy.close()
    const migrated = new MemoryStore(home.config)
    stores.push(migrated)
    const version = migrated.database.prepare('PRAGMA user_version').get() as { user_version: number }
    expect(version.user_version).toBe(2)
    expect(migrated.database.prepare("SELECT value FROM memory_meta WHERE key = 'schema_format'").get()).toMatchObject({ value: '2' })
    expect(migrated.listAudit().some(item => item.action === 'schema.migrate')).toBe(true)
    migrated.close()
    stores.splice(stores.indexOf(migrated), 1)

    const newerHome = temporaryMemoryHome({ markdownProjection: false })
    homes.push(newerHome)
    mkdirSync(join(newerHome.config.storagePath, '..'), { recursive: true })
    const newer = new DatabaseSync(newerHome.config.storagePath)
    newer.exec('PRAGMA user_version = 99')
    newer.close()
    expect(() => new MemoryStore(newerHome.config)).toThrow('newer than supported')
    expect(existsSync(`${newerHome.config.storagePath}.writer.lock`)).toBe(false)
  })

  it('does not treat an unrelated unversioned SQLite database as a new store', () => {
    const home = temporaryMemoryHome({ markdownProjection: false })
    homes.push(home)
    mkdirSync(join(home.config.storagePath, '..'), { recursive: true })
    const unrelated = new DatabaseSync(home.config.storagePath)
    unrelated.exec('CREATE TABLE application_state (value TEXT NOT NULL) STRICT')
    unrelated.close()

    expect(() => new MemoryStore(home.config)).toThrow('unversioned database is not empty')
    expect(existsSync(`${home.config.storagePath}.writer.lock`)).toBe(false)
  })

  it('fails closed on a corrupt canonical store and does not replace it', () => {
    const home = temporaryMemoryHome({ markdownProjection: false })
    homes.push(home)
    const store = new MemoryStore(home.config)
    stores.push(store)
    publish(store)
    store.close()
    stores.splice(stores.indexOf(store), 1)

    const fd = openSync(home.config.storagePath, 'r+')
    try {
      writeSync(fd, Buffer.from('destroyed-sqlite-header'), 0, 23, 0)
    } finally {
      closeSync(fd)
    }
    expect(() => new MemoryStore(home.config)).toThrow()
    expect(existsSync(`${home.config.storagePath}.writer.lock`)).toBe(false)

    const header = Buffer.alloc(23)
    const read = openSync(home.config.storagePath, 'r')
    try {
      readSync(read, header, 0, header.length, 0)
    } finally {
      closeSync(read)
    }
    expect(header.toString()).toBe('destroyed-sqlite-header')
  })
})
