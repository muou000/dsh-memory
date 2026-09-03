import { describe, expect, it } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import { ConfigSchema, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('uses a Harness-home-relative canonical store and safe defaults', () => {
    const config = resolveConfig({ dshHome: resolve('harness-home') }, {})
    expect(isAbsolute(config.storagePath)).toBe(true)
    expect(config.storagePath).toContain('memory')
    expect(config.maxInjectedItems).toBe(6)
    expect(config.injectionTokenBudget).toBe(1_200)
    expect(config.drillDownTokenBudget).toBe(4_096)
    expect(config.injectedKinds).toEqual(['episodic', 'semantic', 'procedural'])
    expect(config.autoConsolidate).toBe(false)
    expect(config.consolidationProvider).toBeUndefined()
    expect(config.consolidationModel).toBeUndefined()
    expect(config.consolidationMaxInputChars).toBe(24_000)
    expect(config.consolidationMaxOutputTokens).toBe(1_200)
    expect(config.consolidationTimeoutMs).toBe(30_000)
    expect(config.consolidationMaxProposals).toBe(3)
    expect(config.consolidationRelevantMemoryLimit).toBe(6)
    expect(config.consolidationMaxConcurrency).toBe(1)
    expect(config.consolidationMaxPendingTurns).toBe(32)
    expect(config.consolidationMaxQueuedChars).toBe(1_000_000)
    expect(config.aiReviewMode).toBe('off')
    expect(config.reviewProvider).toBeUndefined()
    expect(config.reviewModel).toBeUndefined()
    expect(config.reviewMaxInputChars).toBe(64_000)
    expect(config.reviewMaxOutputTokens).toBe(512)
    expect(config.reviewTimeoutMs).toBe(30_000)
    expect(config.reviewMinConfidence).toBe(0.9)
    expect(config.logQueryText).toBe(false)
    expect(config.maintenanceExpiringWithinHours).toBe(72)
    expect(config.maintenanceNegativeFeedbackRatio).toBe(0.5)
    expect(config.nearDuplicateThreshold).toBe(0.65)
    expect(config.maxNearDuplicateSuggestions).toBe(5)
    expect(config.reviewedCandidateRetentionDays).toBe(365)
    expect(config.queryTextRetentionDays).toBe(7)
    expect(config.retrievalRetentionDays).toBe(180)
    expect(config.feedbackRetentionDays).toBe(365)
    expect(config.auditRetentionDays).toBe(3_650)
  })

  it('preserves the same defaults after Loader schema normalization', () => {
    const parsed = ConfigSchema({ dshHome: resolve('harness-home') })
    const config = resolveConfig(parsed, {})
    expect(config.injectedKinds).toEqual(['episodic', 'semantic', 'procedural'])
    expect(config.autoInject).toBe(true)
    expect(config.autoConsolidate).toBe(false)
    expect(config.aiReviewMode).toBe('off')
    expect(config.markdownProjection).toBe(true)
    expect(config.retrievalCandidateLimit).toBe(24)
    expect(config.maintenanceMinimumFeedbackCount).toBe(3)
  })

  it('rejects relative paths, unknown keys, duplicate kinds, and invalid cross-field limits', () => {
    expect(() => resolveConfig({ dshHome: 'relative' }, {})).toThrow('absolute')
    expect(() => resolveConfig({ dshHome: resolve('home'), typo: true } as never, {})).toThrow('unknown key')
    expect(() => resolveConfig({ dshHome: resolve('home'), injectedKinds: ['semantic', 'semantic'] }, {})).toThrow('duplicates')
    expect(() => resolveConfig({
      dshHome: resolve('home'),
      retrievalCandidateLimit: 2,
      maxInjectedItems: 3,
    }, {})).toThrow('retrievalCandidateLimit')
    expect(() => resolveConfig({
      storagePath: resolve('home', 'memory.sqlite'),
      projectionPath: resolve('home', 'memory.sqlite'),
    }, {})).toThrow('SQLite file')
  })

  it('validates automatic consolidation route, lifecycle, and resource limits', () => {
    expect(() => resolveConfig({ consolidationProvider: 'mock' }, {})).toThrow('supplied together')
    expect(() => resolveConfig({ consolidationModel: 'model' }, {})).toThrow('supplied together')
    expect(() => resolveConfig({ consolidationProvider: ' ', consolidationModel: 'model' }, {})).toThrow('non-empty')
    expect(() => resolveConfig({ autoConsolidate: true, readOnly: true }, {})).toThrow('readOnly')
    expect(() => resolveConfig({ aiReviewMode: 'shadow' }, {})).toThrow('autoConsolidate')
    expect(() => resolveConfig({ autoConsolidate: true, aiReviewMode: 'enforce' }, {})).toThrow('reviewProvider')
    expect(() => resolveConfig({ reviewProvider: 'review' }, {})).toThrow('supplied together')
    expect(() => resolveConfig({ reviewModel: 'review-model' }, {})).toThrow('supplied together')
    expect(() => resolveConfig({
      autoConsolidate: true,
      aiReviewMode: 'enforce',
      consolidationProvider: 'same',
      consolidationModel: 'model',
      reviewProvider: 'same',
      reviewModel: 'model',
    }, {})).toThrow('distinct')
    expect(() => resolveConfig({ reviewMinConfidence: 1.1 }, {})).toThrow('reviewMinConfidence')
    expect(() => resolveConfig({ consolidationMaxPendingTurns: 0 }, {})).toThrow('consolidationMaxPendingTurns')
    expect(() => resolveConfig({
      consolidationMaxInputChars: 8_000,
      consolidationMaxQueuedChars: 7_999,
    }, {})).toThrow('consolidationMaxQueuedChars')
    expect(() => resolveConfig({ consolidationMaxConcurrency: 9 }, {})).toThrow('consolidationMaxConcurrency')
    expect(resolveConfig({
      consolidationProvider: ' mock ',
      consolidationModel: ' memory-model ',
    }, {})).toMatchObject({
      consolidationProvider: 'mock',
      consolidationModel: 'memory-model',
    })
  })

  it('fails closed when direct callers bypass the Loader schema with wrong primitive types', () => {
    expect(() => resolveConfig({ readOnly: 'false' as never }, {})).toThrow('readOnly')
    expect(() => resolveConfig({ autoInject: 1 as never }, {})).toThrow('autoInject')
    expect(() => resolveConfig({ autoConsolidate: 1 as never }, {})).toThrow('autoConsolidate')
    expect(() => resolveConfig({ aiReviewMode: 1 as never }, {})).toThrow('aiReviewMode')
    expect(() => resolveConfig({ consolidationProvider: 1 as never }, {})).toThrow('consolidationProvider')
    expect(() => resolveConfig({ reviewProvider: 1 as never }, {})).toThrow('reviewProvider')
    expect(() => resolveConfig({ secretPolicy: true as never }, {})).toThrow('secretPolicy')
    expect(() => resolveConfig({ dshHome: 42 as never }, {})).toThrow('dshHome')
  })
})
