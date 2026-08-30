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

  it('fails closed when direct callers bypass the Loader schema with wrong primitive types', () => {
    expect(() => resolveConfig({ readOnly: 'false' as never }, {})).toThrow('readOnly')
    expect(() => resolveConfig({ autoInject: 1 as never }, {})).toThrow('autoInject')
    expect(() => resolveConfig({ secretPolicy: true as never }, {})).toThrow('secretPolicy')
    expect(() => resolveConfig({ dshHome: 42 as never }, {})).toThrow('dshHome')
  })
})
