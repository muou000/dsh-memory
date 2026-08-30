import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import type { MemoryStore as Store } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, proposer, reviewer, temporaryMemoryHome, workspaceAlpha } from './helpers.ts'

const homes: TemporaryMemoryHome[] = []
const stores: Store[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const home of homes.splice(0)) home.cleanup()
})

function setup(): { home: TemporaryMemoryHome; store: MemoryStore } {
  const home = temporaryMemoryHome({ markdownProjection: false })
  const store = new MemoryStore(home.config)
  homes.push(home)
  stores.push(store)
  return { home, store }
}

describe('MemoryStore governance', () => {
  it('separates proposal from publication and preserves immutable revisions', () => {
    const { store } = setup()
    const candidate = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    expect(candidate.status).toBe('candidate')
    expect(store.listRecords()).toHaveLength(0)

    const reviewed = store.review(candidate.id, {
      action: 'publish',
      actor: reviewer,
      reason: 'Verified by the referenced regression test.',
      now: 2_000,
    })
    expect(reviewed.status).toBe('published')
    const record = store.listRecords()[0]!
    expect(record.revision).toBe(1)
    expect(record.operation).toBe('create')
    expect(record.evidence).toEqual(draft().evidence)

    const update = store.propose({
      operation: 'update',
      targetMemoryId: record.memoryId,
      expectedRevision: 1,
      content: draft({
        action: 'Publish through the non-blocking telemetry queue and flush it outside the stop hook.',
      }),
      actor: proposer,
      now: 3_000,
    })
    store.review(update.id, {
      action: 'publish',
      actor: reviewer,
      reason: 'Adds a verified flush boundary without broadening applicability.',
      now: 4_000,
    })
    const updated = store.listRecords()[0]!
    expect(updated.revision).toBe(2)
    expect(store.listRevisions(updated.memoryId).map(item => item.revision)).toEqual([1, 2])
    expect(store.listRevisions(updated.memoryId)[0]?.action).toBe(draft().action)
  })

  it('makes request retries and exact duplicates idempotent', () => {
    const { store } = setup()
    const first = store.propose({ content: draft(), actor: proposer, requestId: 'call-1', now: 1_000 })
    const retry = store.propose({ content: draft(), actor: proposer, requestId: 'call-1', now: 1_100 })
    expect(retry.id).toBe(first.id)
    store.review(first.id, {
      action: 'publish', actor: reviewer, reason: 'Evidence checked.', now: 2_000,
    })
    const duplicate = store.propose({ content: draft(), actor: proposer, now: 3_000 })
    expect(duplicate.status).toBe('skipped')
    expect(duplicate.exactDuplicateId).toBe(store.listRecords()[0]?.memoryId)
    expect(() => store.propose({
      content: draft(), actor: { kind: 'agent', id: 'different-caller' }, requestId: 'call-1', now: 3_100,
    })).toThrow('different operation data')
  })

  it('replays an update request after its target has advanced', () => {
    const { store } = setup()
    const create = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(create.id, { action: 'publish', actor: reviewer, reason: 'Verified.', now: 2_000 })
    const target = store.listRecords()[0]!
    const content = draft({ action: 'A reviewed correction remains asynchronous.' })
    const update = store.propose({
      operation: 'update', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content, actor: proposer, requestId: 'update-retry', now: 3_000,
    })
    store.review(update.id, { action: 'publish', actor: reviewer, reason: 'Correction verified.', now: 4_000 })
    const retry = store.propose({
      operation: 'update', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content, actor: proposer, requestId: 'update-retry', now: 99_000,
    })
    expect(retry.id).toBe(update.id)
    expect(() => store.propose({
      operation: 'update', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content, actor: { kind: 'agent', id: 'other-agent' }, requestId: 'update-retry', now: 99_000,
    })).toThrow('different operation data')
  })

  it('surfaces near duplicates for review without merging different applicability', () => {
    const { store } = setup()
    const first = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(first.id, { action: 'publish', actor: reviewer, reason: 'Evidence checked.', now: 2_000 })
    const existing = store.listRecords()[0]!
    const similar = store.propose({
      content: draft({
        applicability: 'When reporting telemetry from the stop hook in repository alpha during graceful shutdown.',
        action: 'Queue the report asynchronously and allow shutdown to continue.',
      }),
      actor: proposer,
      now: 3_000,
    })
    expect(similar.status).toBe('candidate')
    expect(similar.exactDuplicateId).toBeUndefined()
    expect(similar.similarMemoryIds).toEqual([existing.memoryId])
    expect(store.listRecords()).toHaveLength(1)
  })

  it('keeps update and contradiction scope and kind immutable', () => {
    const { store } = setup()
    const create = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(create.id, { action: 'publish', actor: reviewer, reason: 'Verified.', now: 2_000 })
    const target = store.listRecords()[0]!
    expect(() => store.propose({
      operation: 'update', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content: draft({
        scope: { type: 'global', key: '*' },
        action: 'A scope-widening correction must be rejected.',
      }), actor: proposer, now: 3_000,
    })).toThrow('cannot change scope')
    expect(() => store.propose({
      operation: 'contradict', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content: draft({
        kind: 'semantic',
        action: 'A cross-kind contradiction must be rejected.',
      }), actor: proposer, now: 3_000,
    })).toThrow('cannot change memory kind')
  })

  it('does not allow an update or contradiction to lower sensitivity', () => {
    const { store } = setup()
    const create = store.propose({
      content: draft({ sensitivity: 'confidential' }), actor: proposer, now: 1_000,
    })
    store.review(create.id, { action: 'publish', actor: reviewer, reason: 'Confidential fixture verified.', now: 2_000 })
    const target = store.listRecords(['active'])[0]!
    expect(() => store.propose({
      operation: 'update', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content: draft({ sensitivity: 'public', action: 'A downgrade must be rejected.' }),
      actor: proposer, now: 3_000,
    })).toThrow('cannot lower sensitivity')
    expect(() => store.propose({
      operation: 'contradict', targetMemoryId: target.memoryId, expectedRevision: target.revision,
      content: draft({ sensitivity: 'internal', action: 'A contradictory downgrade must be rejected.' }),
      actor: proposer, now: 3_000,
    })).toThrow('cannot lower sensitivity')
  })

  it('rejects stale concurrent updates without changing current state', () => {
    const { store } = setup()
    const create = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(create.id, { action: 'publish', actor: reviewer, reason: 'Verified.', now: 2_000 })
    const record = store.listRecords()[0]!
    const first = store.propose({
      operation: 'update', targetMemoryId: record.memoryId, expectedRevision: 1,
      content: draft({ action: 'First correction.' }), actor: proposer, now: 3_000,
    })
    const second = store.propose({
      operation: 'update', targetMemoryId: record.memoryId, expectedRevision: 1,
      content: draft({ action: 'Second correction.' }), actor: proposer, now: 3_100,
    })
    store.review(first.id, { action: 'publish', actor: reviewer, reason: 'First wins after review.', now: 4_000 })
    expect(() => store.review(second.id, {
      action: 'publish', actor: reviewer, reason: 'This review is now stale.', now: 5_000,
    })).toThrow('optimistic revision mismatch')
    expect(store.listRecords()[0]?.action).toBe('First correction.')
    expect(store.listRecords()[0]?.revision).toBe(2)
  })

  it('keeps contradictions explicit and out of normal retrieval', () => {
    const { store } = setup()
    const create = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(create.id, { action: 'publish', actor: reviewer, reason: 'Verified.', now: 2_000 })
    const target = store.listRecords()[0]!
    const contradiction = store.propose({
      operation: 'contradict',
      targetMemoryId: target.memoryId,
      expectedRevision: target.revision,
      content: draft({
        action: 'Send the report synchronously before shutdown.',
        rationale: 'A new runtime is claimed to require immediate delivery.',
      }),
      actor: proposer,
      now: 3_000,
    })
    store.review(contradiction.id, {
      action: 'publish', actor: reviewer, reason: 'Preserve both claims pending owner decision.', now: 4_000,
    })
    expect(store.listRecords(['conflicted'])).toHaveLength(2)
    expect(store.listConflicts('open')).toHaveLength(1)
    expect(store.search('stop hook report', {
      workspace: workspaceAlpha, includeGlobal: false,
    }).hits).toHaveLength(0)

    const conflict = store.listConflicts('open')[0]!
    expect(() => store.propose({
      operation: 'update', targetMemoryId: conflict.leftMemoryId, expectedRevision: conflict.leftRevision,
      content: draft({ action: 'Attempt to bypass the unresolved conflict.' }), actor: proposer, now: 4_500,
    })).toThrow('is conflicted')
    expect(store.listRevisions(conflict.leftMemoryId).at(-1)).toMatchObject({
      revision: conflict.leftRevision,
      operation: 'contradict',
      status: 'conflicted',
    })
    const resolved = store.resolveConflict(conflict.id, {
      action: 'keep-left', actor: reviewer, reason: 'Original behavior remains verified.', now: 5_000,
    })
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolution).toContain('keep-left')
    expect(store.listRecords(['conflicted'])).toHaveLength(0)
    expect(store.listRecords(['active'])).toHaveLength(1)
    expect(store.listRecords(['archived'])).toHaveLength(1)
    expect(store.search('stop hook report', {
      workspace: workspaceAlpha, includeGlobal: false,
    }, { now: 6_000 }).hits).toHaveLength(1)
  })

  it('versions invalidation, revival, deletion, and requires logical deletion before purge', () => {
    const { store } = setup()
    const create = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(create.id, { action: 'publish', actor: reviewer, reason: 'Verified.', now: 2_000 })
    const original = store.listRecords()[0]!
    const stale = store.transition(original.memoryId, {
      action: 'invalidate', expectedRevision: 1, actor: reviewer,
      reason: 'Module was replaced and requires revalidation.', now: 3_000,
    })
    expect(stale.status).toBe('stale')
    expect(stale.revision).toBe(2)
    expect(() => store.transition(original.memoryId, {
      action: 'invalidate', expectedRevision: 2, actor: reviewer,
      reason: 'Cannot invalidate an already stale record.', now: 3_500,
    })).toThrow('invalid transition from stale')
    const active = store.transition(original.memoryId, {
      action: 'revive', expectedRevision: 2, actor: reviewer,
      reason: 'Replacement module retained the same tested contract.', now: 4_000,
    })
    expect(active.status).toBe('active')
    expect(() => store.purge(active.memoryId, reviewer, 'Privacy purge request.', 4_500)).toThrow('logical delete')
    const deleted = store.transition(active.memoryId, {
      action: 'delete', expectedRevision: 3, actor: reviewer,
      reason: 'Approved privacy deletion.', now: 5_000,
    })
    expect(deleted.status).toBe('deleted')
    store.purge(deleted.memoryId, reviewer, 'Approved privacy purge request.', 6_000)
    expect(store.listRecords(['deleted'])).toHaveLength(0)
  })

  it('enforces one writer and permits a read-only observer after the writer closes', () => {
    const { home, store } = setup()
    expect(() => new MemoryStore(home.config)).toThrow('another writer')
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const readOnly = new MemoryStore({ ...home.config, readOnly: true, markdownProjection: false })
    stores.push(readOnly)
    expect(readOnly.health.state).toBe('degraded-read-only')
    expect(() => readOnly.propose({ content: draft(), actor: proposer })).toThrow('read-only')
  })

  it('fails closed when a persisted exact-duplicate reference is semantically miswired', () => {
    const { home, store } = setup()
    const first = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(first.id, { action: 'publish', actor: reviewer, reason: 'First record verified.', now: 2_000 })
    const firstRecord = store.listRecords(['active'])[0]!
    const duplicate = store.propose({ content: draft(), actor: proposer, now: 3_000 })
    expect(duplicate.status).toBe('skipped')
    const second = store.propose({
      content: draft({ subject: 'A distinct second record' }), actor: proposer, now: 4_000,
    })
    store.review(second.id, { action: 'publish', actor: reviewer, reason: 'Second record verified.', now: 5_000 })
    const secondRecord = store.listRecords(['active']).find(item => item.memoryId !== firstRecord.memoryId)!
    store.database.prepare('UPDATE memory_candidates SET exact_duplicate_id = ? WHERE id = ?')
      .run(secondRecord.memoryId, duplicate.id)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    expect(() => new MemoryStore(home.config)).toThrow('exact duplicate does not contain')
  })

  it('fails closed when denormalized feedback counters are tampered', () => {
    const { home, store } = setup()
    const candidate = store.propose({ content: draft(), actor: proposer, now: 1_000 })
    store.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Feedback fixture verified.', now: 2_000 })
    const record = store.listRecords(['active'])[0]!
    store.feedback({
      memoryId: record.memoryId,
      revision: record.revision,
      kind: 'helpful',
      actor: reviewer,
      now: 3_000,
    })
    store.database.prepare('UPDATE memory_records SET positive_feedback = positive_feedback + 7 WHERE id = ?')
      .run(record.memoryId)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    expect(() => new MemoryStore(home.config)).toThrow('feedback counters disagree')
  })
})
