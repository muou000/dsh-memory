import { describe, expect, it } from 'vitest'
import { normalizeContent } from '../src/content.ts'
import { draft } from './helpers.ts'

describe('proposal safety', () => {
  it('rejects secret-like content without storing a partial candidate', () => {
    expect(() => normalizeContent(draft({
      action: 'Set api_key=super-secret-value before calling the service.',
    }), {
      now: 1_000,
      maxChars: 8_000,
      maxWorkingTtlHours: 24,
      secretPolicy: 'reject',
    })).toThrow('secret-like')
  })

  it('redacts every structured field and evidence note under redact policy', () => {
    const value = normalizeContent(draft({
      subject: 'password=hunter2',
      action: 'Use access_token=abcdefghijklmnop.',
      evidence: [{ kind: 'human', locator: 'ticket', note: 'client_secret=abcdefghijklmnop' }],
    }), {
      now: 1_000,
      maxChars: 8_000,
      maxWorkingTtlHours: 24,
      secretPolicy: 'redact',
    })
    expect(JSON.stringify(value)).not.toContain('hunter2')
    expect(JSON.stringify(value)).not.toContain('abcdefghijklmnop')
    expect(JSON.stringify(value)).toContain('[REDACTED_SECRET]')
  })

  it('requires expiring session scope for working records', () => {
    expect(() => normalizeContent(draft({ kind: 'working' }), {
      now: 1_000, maxChars: 8_000, maxWorkingTtlHours: 24, secretPolicy: 'reject',
    })).toThrow('session scope')
    expect(() => normalizeContent(draft({
      kind: 'working', scope: { type: 'session', key: 'session-1' }, expiresAt: 1_000 + 25 * 60 * 60 * 1_000,
    }), {
      now: 1_000, maxChars: 8_000, maxWorkingTtlHours: 24, secretPolicy: 'reject',
    })).toThrow('TTL')
  })
})
