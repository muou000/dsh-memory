import { describe, expect, it } from 'vitest'
import { isAbsolute } from 'node:path'
import { ConfigSchema, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('uses a Harness-home-relative canonical store and safe defaults', () => {
    const config = resolveConfig({ dshHome: 'D:\\harness-home' }, {})
    expect(isAbsolute(config.storagePath)).toBe(true)
    expect(config.storagePath).toContain('memory')
    expect(config.maxInjectedItems).toBe(6)
    expect(config.injectionTokenBudget).toBe(1_200)
    expect(config.injectedKinds).toEqual(['episodic', 'semantic', 'procedural'])
    expect(config.logQueryText).toBe(false)
  })

  it('preserves the same defaults after Loader schema normalization', () => {
    const parsed = ConfigSchema({ dshHome: 'D:\\harness-home' })
    const config = resolveConfig(parsed, {})
    expect(config.injectedKinds).toEqual(['episodic', 'semantic', 'procedural'])
    expect(config.autoInject).toBe(true)
    expect(config.markdownProjection).toBe(true)
    expect(config.retrievalCandidateLimit).toBe(24)
  })

  it('rejects relative paths, unknown keys, duplicate kinds, and invalid cross-field limits', () => {
    expect(() => resolveConfig({ dshHome: 'relative' }, {})).toThrow('absolute')
    expect(() => resolveConfig({ dshHome: 'D:\\home', typo: true } as never, {})).toThrow('unknown key')
    expect(() => resolveConfig({ dshHome: 'D:\\home', injectedKinds: ['semantic', 'semantic'] }, {})).toThrow('duplicates')
    expect(() => resolveConfig({
      dshHome: 'D:\\home',
      retrievalCandidateLimit: 2,
      maxInjectedItems: 3,
    }, {})).toThrow('retrievalCandidateLimit')
  })
})
