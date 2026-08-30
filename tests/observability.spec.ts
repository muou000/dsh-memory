import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { queryHash } from '../src/content.ts'
import { MemoryService } from '../src/service.ts'
import { MemoryStore } from '../src/store.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, proposer, reviewer, temporaryMemoryHome, workspaceAlpha } from './helpers.ts'

let home: TemporaryMemoryHome | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  home?.cleanup()
  ctx = undefined
  home = undefined
})

describe('operational observability', () => {
  it('emits content-free classified logs and exposes joined counters', () => {
    home = temporaryMemoryHome({ markdownProjection: false })
    ctx = new Context()
    const service = new MemoryService(ctx, home.config)
    const candidate = service.propose({
      content: draft({ subject: 'BODY-MARKER-NEVER-LOG' }),
      actor: proposer,
      now: 1_000,
    })
    expect(() => service.review(candidate.id, {
      action: 'publish', actor: reviewer, reason: 'api_key=abcdefghijklmnop', now: 2_000,
    })).toThrow('secret-like')
    service.review(candidate.id, { action: 'publish', actor: reviewer, reason: 'Evidence checked.', now: 3_000 })
    const record = service.listRecords()[0]!
    service.recordRetrieval({
      id: 'retrieval-hit',
      queryHash: queryHash('queue telemetry'),
      context: { workspace: workspaceAlpha },
      candidateCount: 1,
      selected: [{ memoryId: record.memoryId, revision: record.revision, score: 1 }],
      tokenBudget: 100,
      estimatedTokens: 10,
      durationMs: 3,
      now: 4_000,
    })
    service.recordRetrieval({
      id: 'retrieval-miss',
      queryHash: queryHash('missing fact'),
      context: { workspace: workspaceAlpha },
      candidateCount: 0,
      selected: [],
      tokenBudget: 100,
      estimatedTokens: 0,
      durationMs: 7,
      now: 4_100,
    })
    service.feedback({
      memoryId: record.memoryId,
      revision: record.revision,
      retrievalId: 'retrieval-hit',
      kind: 'helpful',
      actor: reviewer,
      now: 4_200,
    })

    expect(service.metrics(5_000)).toMatchObject({
      retrievalCount: 2,
      retrievalNoHitCount: 1,
      retrievalNoHitRate: 0.5,
      selectedCount: 1,
      injectedCount: 1,
      estimatedTokenTotal: 10,
      retrievalDurationMs: { p50: 3, p95: 7, max: 7 },
      feedbackByKind: { helpful: 1, harmful: 0, irrelevant: 0, stale: 0 },
      proposalOutcomes: { candidate: 0, published: 1, rejected: 0, skipped: 0 },
      databaseContentionCount: 0,
      backgroundTaskFailures: 0,
      projectionFailures: 0,
    })
    const logs = JSON.stringify(ctx.logger.buffer)
    expect(logs).toContain('secret_rejected')
    expect(logs).toContain('retrieval_id=%s')
    expect(logs).not.toContain('BODY-MARKER-NEVER-LOG')
    expect(logs).not.toContain('abcdefghijklmnop')
  })

  it('exposes writer-lock collisions with an explicit process-local scope', () => {
    home = temporaryMemoryHome({ markdownProjection: false })
    const first = new MemoryStore(home.config)
    try {
      expect(() => new MemoryStore(home!.config)).toThrow('another writer')
      expect(first.metrics(5_000).databaseContentionCount).toBe(1)
      expect(first.metrics(5_000).backgroundTaskFailures).toBe(0)
    } finally {
      first.close()
    }
  })
})
