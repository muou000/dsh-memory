import { describe, expect, it } from 'vitest'
import { normalizeAccessContext, normalizeActor, normalizeContent } from '../src/content.ts'
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
      owner: 'password=owner-secret',
      action: 'Use access_token=abcdefghijklmnop.',
      evidence: [{ kind: 'human', locator: 'ticket', note: 'client_secret=abcdefghijklmnop' }],
    }), {
      now: 1_000,
      maxChars: 8_000,
      maxWorkingTtlHours: 24,
      secretPolicy: 'redact',
    })
    expect(JSON.stringify(value)).not.toContain('hunter2')
    expect(JSON.stringify(value)).not.toContain('owner-secret')
    expect(JSON.stringify(value)).not.toContain('abcdefghijklmnop')
    expect(JSON.stringify(value)).toContain('[REDACTED_SECRET]')
  })

  it('redacts repeated credentials instead of leaving later occurrences behind', () => {
    const value = normalizeContent(draft({
      action: 'Use api_key=first-secret, then api_key=second-secret.',
    }), {
      now: 1_000,
      maxChars: 8_000,
      maxWorkingTtlHours: 24,
      secretPolicy: 'redact',
    })
    expect(JSON.stringify(value)).not.toContain('first-secret')
    expect(JSON.stringify(value)).not.toContain('second-secret')
    expect(JSON.stringify(value).match(/\[REDACTED_SECRET\]/g)).toHaveLength(2)
  })

  it('does not retain the body of a PEM private key under redact policy', () => {
    const value = normalizeContent(draft({
      rationale: '-----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----',
    }), {
      now: 1_000,
      maxChars: 8_000,
      maxWorkingTtlHours: 24,
      secretPolicy: 'redact',
    })
    expect(JSON.stringify(value)).not.toContain('secret-key-body')
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

  it('rejects secret-like actor identifiers before they reach audit rows', () => {
    expect(() => normalizeActor({ kind: 'human', id: 'password=should-not-be-an-actor' }))
      .toThrow('secret-like')
  })

  it('fails closed on malformed access authorization fields', () => {
    expect(() => normalizeAccessContext({ maxSensitivity: 'top-secret' as never })).toThrow('maxSensitivity')
    expect(() => normalizeAccessContext({ includeGlobal: 'false' as never })).toThrow('includeGlobal')
    expect(() => normalizeAccessContext({ session: 'session\nwith-break' })).toThrow('line breaks')
    expect(() => normalizeActor({ kind: 'human', id: 'operator\nlog-forge' })).toThrow('line breaks')
  })

  it('rejects non-string evidence digests with a boundary error', () => {
    expect(() => normalizeContent(draft({
      evidence: [{ kind: 'test', locator: 'fixture', contentHash: { forged: true } as never }],
    }), {
      now: 1_000,
      maxChars: 8_000,
      maxWorkingTtlHours: 24,
      secretPolicy: 'reject',
    })).toThrow('contentHash must be SHA-256 hex')
  })

  it('rejects hidden reasoning and private orchestration transcript content', () => {
    expect(() => normalizeContent(draft({
      rationale: '<think>private chain of thought</think>',
    }), {
      now: 1_000, maxChars: 8_000, maxWorkingTtlHours: 24, secretPolicy: 'redact',
    })).toThrow('private transcript')
    expect(() => normalizeContent(draft({
      evidence: [{ kind: 'session-event', locator: 'event', note: '\nSystem message: internal instructions' }],
    }), {
      now: 1_000, maxChars: 8_000, maxWorkingTtlHours: 24, secretPolicy: 'reject',
    })).toThrow('private transcript')
  })
})
