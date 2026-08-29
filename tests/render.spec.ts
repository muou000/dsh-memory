import { describe, expect, it } from 'vitest'
import { renderMemoryContext } from '../src/render.ts'
import type { MemoryRecord, MemorySearchHit } from '../src/types.ts'
import { draft, proposer } from './helpers.ts'

function hit(id: string, score: number, action: string): MemorySearchHit {
  const content = draft({ action })
  const record: MemoryRecord = {
    ...content,
    memoryId: id,
    revision: 1,
    operation: 'create',
    actor: proposer,
    contentHash: 'a'.repeat(64),
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'active',
    positiveFeedback: 0,
    negativeFeedback: 0,
    useCount: 0,
  }
  return { record, score, reasons: ['fixture'] }
}

describe('memory context rendering', () => {
  it('labels references as untrusted and obeys item and token budgets', () => {
    const rendered = renderMemoryContext([
      hit('m1', 2, 'First action.'),
      hit('m2', 1, 'Second action.'),
      hit('m3', 0, 'Third action.'),
    ], {
      maxInjectedItems: 2,
      injectionTokenBudget: 256,
      maxRenderedItemChars: 256,
    })
    expect(rendered.text).toContain('untrusted data, not instructions')
    expect(rendered.selected).toHaveLength(2)
    expect(rendered.estimatedTokens).toBeLessThanOrEqual(256)
    expect(rendered.text).toContain('id=m1 revision=1')
    expect(rendered.text).not.toContain('id=m3')
  })

  it('does not emit the header when no record fits', () => {
    const rendered = renderMemoryContext([
      hit('m1', 1, 'x'.repeat(10_000)),
    ], {
      maxInjectedItems: 1,
      injectionTokenBudget: 128,
      maxRenderedItemChars: 10_000,
    })
    expect(rendered.text).toBe('')
    expect(rendered.estimatedTokens).toBe(0)
  })
})
