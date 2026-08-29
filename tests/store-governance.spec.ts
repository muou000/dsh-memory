import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import type { MemoryStore as Store } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, proposer, reviewer, temporaryMemoryHome } from './helpers.ts'

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
      workspace: 'D:\\work\\alpha', includeGlobal: false,
    }).hits).toHaveLength(0)

    const conflict = store.listConflicts('open')[0]!
    const resolved = store.resolveConflict(conflict.id, {
      action: 'keep-left', actor: reviewer, reason: 'Original behavior remains verified.', now: 5_000,
    })
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolution).toContain('keep-left')
    expect(store.listRecords(['conflicted'])).toHaveLength(0)
    expect(store.listRecords(['active'])).toHaveLength(1)
    expect(store.listRecords(['archived'])).toHaveLength(1)
    expect(store.search('stop hook report', {
      workspace: 'D:\\work\\alpha', includeGlobal: false,
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
})
