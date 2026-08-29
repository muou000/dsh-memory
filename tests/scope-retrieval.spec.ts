import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, proposer, reviewer, temporaryMemoryHome } from './helpers.ts'

let home: TemporaryMemoryHome | undefined
let store: MemoryStore | undefined

afterEach(() => {
  store?.close()
  home?.cleanup()
  store = undefined
  home = undefined
})

function setup(): MemoryStore {
  home = temporaryMemoryHome({ markdownProjection: false, minConfidence: 0 })
  store = new MemoryStore(home.config)
  return store
}

function publish(memory: MemoryStore, content: ReturnType<typeof draft>, now: number): string {
  const candidate = memory.propose({ content, actor: proposer, now })
  memory.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Fixture verification.', now: now + 1 })
  return memory.listRecords().find(record => record.contentHash === candidate.contentHash)!.memoryId
}

describe('scope-filtered retrieval', () => {
  it('returns exact workspace and global records but never another workspace', () => {
    const memory = setup()
    publish(memory, draft({
      subject: 'Alpha proxy route',
      action: 'Use the alpha-proxy adapter for third-party calls.',
      scope: { type: 'workspace', key: 'D:\\work\\alpha' },
    }), 1_000)
    publish(memory, draft({
      subject: 'Beta proxy route',
      action: 'Use the beta-only proxy token.',
      scope: { type: 'workspace', key: 'D:\\work\\beta' },
    }), 2_000)
    publish(memory, draft({
      subject: 'Global proxy safety',
      action: 'Never include credentials in proxy error logs.',
      scope: { type: 'global', key: '*' },
    }), 3_000)

    const hits = memory.search('proxy', {
      workspace: 'D:\\work\\alpha',
      includeGlobal: true,
      maxSensitivity: 'internal',
    }).hits
    expect(hits.map(hit => hit.record.subject)).toContain('Alpha proxy route')
    expect(hits.map(hit => hit.record.subject)).toContain('Global proxy safety')
    expect(hits.map(hit => hit.record.subject)).not.toContain('Beta proxy route')
    expect(JSON.stringify(hits)).not.toContain('beta-only')
  })

  it('filters sensitivity, expiration, stale state, and kind before ranking', () => {
    const memory = setup()
    const publicId = publish(memory, draft({
      subject: 'Public timeout rule', sensitivity: 'public', kind: 'semantic',
    }), 1_000)
    publish(memory, draft({
      subject: 'Confidential timeout rule', sensitivity: 'confidential', kind: 'semantic',
    }), 2_000)
    publish(memory, draft({
      subject: 'Expired timeout event', kind: 'episodic', expiresAt: 3_000,
    }), 2_500)
    const staleId = publish(memory, draft({
      subject: 'Stale timeout procedure', kind: 'procedural',
    }), 3_000)
    const stale = memory.listRecords().find(record => record.memoryId === staleId)!
    memory.transition(staleId, {
      action: 'invalidate', expectedRevision: stale.revision, actor: reviewer,
      reason: 'The related module was removed.', now: 3_500,
    })

    const hits = memory.search('timeout', {
      workspace: 'D:\\work\\alpha', includeGlobal: false, maxSensitivity: 'public',
    }, { now: 4_000, kinds: ['semantic'] }).hits
    expect(hits.map(hit => hit.record.memoryId)).toEqual([publicId])
  })

  it('uses deterministic ordering and records only query hashes by default', () => {
    const memory = setup()
    publish(memory, draft({ subject: 'Queue alpha', action: 'Use queue transport.' }), 1_000)
    publish(memory, draft({ subject: 'Queue beta', action: 'Use queue fallback.' }), 2_000)
    const first = memory.search('queue', { workspace: 'D:\\work\\alpha' }, { now: 10_000 })
    const second = memory.search('queue', { workspace: 'D:\\work\\alpha' }, { now: 10_000 })
    expect(first.hits.map(hit => hit.record.memoryId)).toEqual(second.hits.map(hit => hit.record.memoryId))
    expect(first.queryHash).toMatch(/^[a-f0-9]{64}$/)
  })
})
