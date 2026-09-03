import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { sep } from 'node:path'
import {
  AutomaticMemoryConsolidator,
} from '../src/consolidator.ts'
import type { Config } from '../src/config.ts'
import { MemoryService } from '../src/service.ts'
import type { TemporaryMemoryHome } from './helpers.ts'
import { draft, reviewer, temporaryMemoryHome } from './helpers.ts'

let context: Context | undefined
let home: TemporaryMemoryHome | undefined

class JsonAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly outputs: Array<string | readonly StreamChunk[]>

  constructor(outputs: readonly (string | readonly StreamChunk[])[]) {
    super()
    this.outputs = [...outputs]
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const output = this.outputs[this.requests.length - 1]
    if (output === undefined) throw new Error('missing scripted consolidation output')
    if (typeof output !== 'string') {
      yield * output
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class BlockingAdapter extends LlmAdapter {
  readonly started: Promise<void>
  aborted = false
  private resolveStarted: () => void = () => undefined

  constructor() {
    super()
    this.started = new Promise<void>(resolve => {
      this.resolveStarted = resolve
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected a consolidation cancellation signal')
    this.resolveStarted()
    await new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        this.aborted = true
        reject(signal.reason)
      }
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}

class ReviewBlockingAdapter extends LlmAdapter {
  readonly reviewStarted: Promise<void>
  reviewAborted = false
  private resolveReviewStarted: () => void = () => undefined

  constructor() {
    super()
    this.reviewStarted = new Promise<void>(resolve => {
      this.resolveReviewStarted = resolve
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const source = options.messages[0]?.source
    if (source?.kind === 'plugin' && source.plugin === 'dsh-memory/consolidator') {
      const output = createProposal('Review disposal ordering')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const signal = options.signal
    if (signal === undefined) throw new Error('expected an AI review cancellation signal')
    this.resolveReviewStarted()
    await new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        this.reviewAborted = true
        reject(signal.reason)
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  home?.cleanup()
  context = undefined
  home = undefined
})

async function setup(
  outputs: readonly (string | readonly StreamChunk[])[],
  overrides: Config = {},
  installFlushProvider = true,
): Promise<{
  ctx: Context
  adapter: JsonAdapter
  service: MemoryService
  consolidator: AutomaticMemoryConsolidator
}> {
  home = temporaryMemoryHome({
    autoConsolidate: true,
    consolidationMaxInputChars: 8_000,
    consolidationMaxOutputTokens: 512,
    consolidationTimeoutMs: 5_000,
    markdownProjection: false,
    ...overrides,
  })
  const ctx = new Context()
  context = ctx
  ctx.provide('sessionPersistence', {} as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  if (installFlushProvider) ctx.on('session/flush', () => undefined)
  const adapter = new JsonAdapter(outputs)
  ctx.llm.registerAdapter(['mock', 'review'], adapter)
  const service = new MemoryService(ctx, home.config)
  const consolidator = new AutomaticMemoryConsolidator(ctx, home.config)
  ctx.effect(() => consolidator.start())
  return { ctx, adapter, service, consolidator }
}

function appendCompletedTurn(
  ctx: Context,
  sessionName: string,
  turn: number,
  userText: string,
  assistantText: string,
  excludedPluginText?: string,
  excludedReasoning?: string,
  workspace = home!.root,
): ReturnType<Context['sessions']['create']> {
  const id = SessionId(sessionName)
  const existing = ctx.sessions.get(id)
  const session = existing ?? ctx.sessions.create(id, {
    meta: { cwd: workspace, createdAt: 1_700_000_000_000 },
  })
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (excludedPluginText !== undefined) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: excludedPluginText }],
      source: { kind: 'plugin', plugin: 'test-private-context' },
    }), { surfaceOp: 'append' })
  }
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [
        ...(excludedReasoning === undefined ? [] : [{ type: 'reasoning' as const, text: excludedReasoning }]),
        { type: 'text', text: assistantText },
      ],
      source: { provider: 'mock', model: 'memory-model' },
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return session
}

function createProposal(subject: string): string {
  return JSON.stringify({
    proposals: [{
      operation: 'create',
      kind: 'semantic',
      subject,
      applicability: 'When editing the workspace memory plugin.',
      action: 'Use the durable turn/end event as the automatic trigger.',
      rationale: 'The event is committed after the complete turn and does not block the model loop.',
      confidence: 0.88,
    }],
  })
}

function reviewDecision(
  verdict: 'publish' | 'reject' | 'defer',
  confidence = 0.96,
  checks?: {
    grounded: boolean
    durable: boolean
    scopeCorrect: boolean
    nonSensitive: boolean
    useful: boolean
    nonDuplicate: boolean
    nonConflicting: boolean
  },
): string {
  const resolvedChecks = checks ?? {
    grounded: true,
    durable: true,
    scopeCorrect: true,
    nonSensitive: true,
    useful: verdict !== 'reject',
    nonDuplicate: true,
    nonConflicting: true,
  }
  return JSON.stringify({
    decisions: [{
      verdict,
      reason: verdict === 'publish'
        ? 'The candidate is supported by the source turn and is durable workspace knowledge.'
        : verdict === 'reject'
          ? 'The candidate is not durable workspace knowledge.'
          : 'The evidence is not strong enough for automatic publication.',
      confidence,
      checks: resolvedChecks,
    }],
  })
}

describe('automatic turn-end memory consolidation', () => {
  it('queues a model call without blocking turn/end and creates only a review candidate', async () => {
    const { ctx, adapter, service, consolidator } = await setup([
      createProposal('Automatic consolidation trigger'),
    ])

    const session = appendCompletedTurn(
      ctx,
      'auto-create',
      1,
      'Please make memory summarization automatic after every completed turn.',
      'The plugin now queues work from turn/end and leaves publication to review.',
      'PLUGIN-CONTEXT-MUST-NOT-BE-SENT',
      'ASSISTANT-REASONING-MUST-NOT-BE-SENT',
    )
    expect(service.listCandidates()).toEqual([])
    const duplicateEnd = session.events.find(event => event.type === 'turn/end')
    if (duplicateEnd?.type === 'turn/end') ctx.emit('session/event', session, duplicateEnd)

    await consolidator.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'mock',
      model: 'memory-model',
      maxTokens: 512,
      sessionId: session.id,
    })
    const modelInput = JSON.stringify(adapter.requests[0]?.messages)
    expect(modelInput).toContain('every completed turn')
    expect(modelInput).not.toContain('PLUGIN-CONTEXT-MUST-NOT-BE-SENT')
    expect(modelInput).not.toContain('ASSISTANT-REASONING-MUST-NOT-BE-SENT')
    expect(service.listRecords()).toEqual([])
    expect(service.listCandidates()).toHaveLength(1)
    expect(service.listCandidates()[0]).toMatchObject({
      operation: 'create',
      status: 'candidate',
      content: {
        scope: { type: 'workspace', key: home!.root },
        subject: 'Automatic consolidation trigger',
        sensitivity: 'internal',
      },
      actor: { kind: 'agent', id: 'memory-consolidator:auto-create' },
      requestId: 'automatic:auto-create:created:1700000000000:turn:1:proposal:0',
    })
    expect(service.listCandidates()[0]?.content.evidence[0]?.locator)
      .toMatch(/^session:auto-create;turn:1;through-seq:/)
    expect(session.events.some(event => event.type.startsWith('memory/consolidation-'))).toBe(false)
    const requestAudits = service.listAudit().filter(row => row.action === 'consolidation.request')
    expect(requestAudits).toHaveLength(1)
    const requestAudit = requestAudits[0]
    expect(requestAudit).toMatchObject({
      entityType: 'consolidation',
      entityId: 'automatic:auto-create:created:1700000000000:turn:1',
      details: {
        promptVersion: 1,
        sessionId: 'auto-create',
        turn: 1,
        provider: 'mock',
        model: 'memory-model',
        maxInputChars: 8_000,
        maxProposals: 3,
        maxTokens: 512,
      },
    })
    expect(requestAudit?.details.systemHash).toMatch(/^[a-f0-9]{64}$/)
    expect(requestAudit?.details.inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(requestAudit)).not.toContain('every completed turn')
    const resultAudit = service.listAudit().find(row => row.action === 'consolidation.complete')
    expect(resultAudit?.details.candidateIds).toEqual([service.listCandidates()[0]?.id])
  })

  it('uses a distinct configured AI reviewer route to publish a high-confidence candidate', async () => {
    const { ctx, adapter, service, consolidator } = await setup([
      createProposal('AI-reviewed memory'),
      reviewDecision('publish'),
    ], {
      aiReviewMode: 'enforce',
      reviewProvider: 'review',
      reviewModel: 'review-model',
    })

    appendCompletedTurn(
      ctx,
      'auto-ai-publish',
      1,
      'Use an independent AI reviewer for automatic publication.',
      'Only strongly grounded candidates should be published.',
    )
    await consolidator.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toMatchObject({ provider: 'review', model: 'review-model' })
    expect(adapter.requests[1]?.messages[0]?.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-memory/reviewer',
    })
    expect(service.listCandidates()).toEqual([])
    expect(service.listCandidates('published')).toHaveLength(1)
    expect(service.listCandidates('published')[0]).toMatchObject({
      reviewer: { kind: 'policy' },
      decisionReason: expect.stringContaining('AI review:'),
    })
    expect(service.listRecords()).toHaveLength(1)
    expect(service.listAudit().filter(row => row.action === 'ai-review.request')).toHaveLength(1)
    expect(service.listAudit().filter(row => row.action === 'ai-review.complete')).toHaveLength(1)
  })

  it('keeps a low-confidence AI review pending for manual review', async () => {
    const { ctx, service, consolidator } = await setup([
      createProposal('Deferred AI-reviewed memory'),
      reviewDecision('publish', 0.6),
    ], {
      aiReviewMode: 'enforce',
      reviewProvider: 'review',
      reviewModel: 'review-model',
      reviewMinConfidence: 0.9,
    })

    appendCompletedTurn(
      ctx,
      'auto-ai-defer',
      1,
      'Do not publish uncertain memories.',
      'Low-confidence decisions stay in the review queue.',
    )
    await consolidator.whenIdle()

    expect(service.listCandidates()).toHaveLength(1)
    expect(service.listRecords()).toEqual([])
    const result = service.listAudit().find(row => row.action === 'ai-review.complete')
    expect(result?.details).toMatchObject({
      mode: 'enforce',
      decisions: [{ verdict: 'publish', effectiveAction: 'defer' }],
    })
  })

  it('records a high-confidence recommendation without publishing in shadow mode', async () => {
    const { ctx, service, consolidator } = await setup([
      createProposal('Shadow-reviewed memory'),
      reviewDecision('publish'),
    ], {
      aiReviewMode: 'shadow',
      reviewProvider: 'review',
      reviewModel: 'review-model',
      auditRetentionDays: 1,
    })

    appendCompletedTurn(
      ctx,
      'auto-ai-shadow',
      1,
      'Review this candidate without changing canonical knowledge.',
      'Shadow mode must leave the candidate pending.',
    )
    await consolidator.whenIdle()

    expect(service.listCandidates()).toHaveLength(1)
    expect(service.listRecords()).toEqual([])
    const result = service.listAudit().find(row => row.action === 'ai-review.complete')
    expect(result?.details).toMatchObject({
      mode: 'shadow',
      decisions: [{ verdict: 'publish', effectiveAction: 'defer' }],
    })
    service.prune(
      { kind: 'system', id: 'retention-test' },
      'Verify pending automatic review provenance remains available.',
      Date.now() + 2 * 86_400_000,
    )
    expect(service.listAudit().some(row => row.action === 'consolidation.request')).toBe(true)
    expect(service.listAudit().some(row => row.action === 'consolidation.complete')).toBe(true)
    expect(service.listAudit().some(row => row.action === 'ai-review.request')).toBe(true)
    expect(service.listAudit().some(row => row.action === 'ai-review.complete')).toBe(true)
  })

  it('allows a high-confidence AI reviewer to reject a locally duplicate-adjacent candidate', async () => {
    const { ctx, service, consolidator } = await setup([
      createProposal('Rejected AI-reviewed memory'),
      reviewDecision('reject'),
    ], {
      aiReviewMode: 'enforce',
      reviewProvider: 'review',
      reviewModel: 'review-model',
      nearDuplicateThreshold: 0.1,
    })
    const seed = service.propose({
      content: draft({
        kind: 'semantic',
        scope: { type: 'workspace', key: home!.root },
        subject: 'Existing reviewed memory trigger',
        applicability: 'When editing the workspace memory plugin.',
        action: 'Use the durable turn/end event as the automatic trigger.',
        rationale: 'This previously published record covers the same operating rule.',
      }),
      actor: { kind: 'migration', id: 'AI review fixture' },
    })
    service.review(seed.id, {
      action: 'publish',
      actor: reviewer,
      reason: 'Seed duplicate hint reviewed for AI rejection test.',
    })

    appendCompletedTurn(
      ctx,
      'auto-ai-reject',
      1,
      'Reject temporary task state.',
      'This result is not durable project knowledge.',
    )
    await consolidator.whenIdle()

    expect(service.listCandidates()).toEqual([])
    expect(service.listCandidates('rejected')).toHaveLength(1)
    expect(service.listRecords()).toHaveLength(1)
  })

  it('defers a contradictory reject verdict whose checks all pass', async () => {
    const { ctx, service, consolidator } = await setup([
      createProposal('Contradictory rejection'),
      reviewDecision('reject', 0.99, {
        grounded: true,
        durable: true,
        scopeCorrect: true,
        nonSensitive: true,
        useful: true,
        nonDuplicate: true,
        nonConflicting: true,
      }),
    ], {
      aiReviewMode: 'enforce',
      reviewProvider: 'review',
      reviewModel: 'review-model',
    })

    appendCompletedTurn(ctx, 'auto-ai-contradict', 1, 'Retain safe review fallbacks.', 'Contradictions defer.')
    await consolidator.whenIdle()

    expect(service.listCandidates()).toHaveLength(1)
    expect(service.listCandidates('rejected')).toEqual([])
    expect(service.listAudit().find(row => row.action === 'ai-review.complete')?.details)
      .toMatchObject({ decisions: [{ verdict: 'reject', effectiveAction: 'defer' }] })
  })

  it('does not send secret-like source text to the second review route', async () => {
    const { ctx, adapter, service, consolidator } = await setup([
      createProposal('Sensitive review source'),
      reviewDecision('publish'),
    ], {
      aiReviewMode: 'enforce',
      reviewProvider: 'review',
      reviewModel: 'review-model',
    })

    appendCompletedTurn(
      ctx,
      'auto-ai-sensitive',
      1,
      'Remember credential AKIAIOSFODNN7EXAMPLE for later.',
      'Credentials must not be forwarded to another provider.',
    )
    await consolidator.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(service.listCandidates()).toHaveLength(1)
    expect(service.listAudit().some(row => row.action === 'ai-review.request')).toBe(false)
    expect(service.metrics().backgroundTaskFailures).toBe(1)
  })

  it('defers when the configured reviewer resolves to the extraction route', async () => {
    const { ctx, adapter, service, consolidator } = await setup([
      createProposal('Same-route review'),
      reviewDecision('publish'),
    ], {
      aiReviewMode: 'enforce',
      reviewProvider: 'mock',
      reviewModel: 'memory-model',
    })

    appendCompletedTurn(ctx, 'auto-ai-same-route', 1, 'Use route diversity.', 'Self-review must defer.')
    await consolidator.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(service.listCandidates()).toHaveLength(1)
    expect(service.listAudit().some(row => row.action === 'ai-review.request')).toBe(false)
    expect(service.metrics().backgroundTaskFailures).toBe(1)
  })

  it('deterministically bounds long framed inputs without hanging at the minimum limit', async () => {
    const { ctx, adapter, consolidator } = await setup([
      createProposal('Bounded consolidation input'),
    ], { consolidationMaxInputChars: 1_024 })

    appendCompletedTurn(
      ctx,
      'auto-bounded-input',
      1,
      `USER-START-${'u'.repeat(5_000)}`,
      `ASSISTANT-START-${'a'.repeat(5_000)}`,
    )
    await consolidator.whenIdle()

    const block = adapter.requests[0]?.messages[0]?.content[0]
    expect(block?.type).toBe('text')
    expect(block?.type === 'text' && block.text.length).toBeLessThanOrEqual(1_024)
    expect(block?.type === 'text' && block.text).toContain('USER-START-')
    expect(block?.type === 'text' && block.text).toContain('ASSISTANT-START-')
  })

  it('caps the retrieval query at the canonical store limit before framing', async () => {
    const { ctx, adapter, consolidator } = await setup([
      createProposal('Bounded consolidation query'),
    ], { consolidationMaxInputChars: 24_000 })

    appendCompletedTurn(
      ctx,
      'auto-bounded-query',
      1,
      `QUERY-START-${'q'.repeat(30_000)}`,
      'The long request still produces a bounded search query.',
    )
    await consolidator.whenIdle()

    expect(adapter.requests).toHaveLength(1)
  })

  it('fails closed before model dispatch when no durable session flush provider participates', async () => {
    const { ctx, adapter, service, consolidator } = await setup([
      createProposal('Must not be generated'),
    ], {}, false)

    const session = appendCompletedTurn(
      ctx,
      'auto-no-persistence',
      1,
      'Do not dispatch unless the source request is durable.',
      'The memory worker must fail closed.',
    )
    await consolidator.whenIdle()

    expect(adapter.requests).toEqual([])
    expect(service.listCandidates()).toEqual([])
    expect(service.metrics().backgroundTaskFailures).toBe(1)
    expect(session.events.some(event => event.type.startsWith('memory/consolidation-'))).toBe(false)
    expect(service.listAudit().some(row => row.action.startsWith('consolidation.'))).toBe(false)
  })

  it('rejects a malformed stream that ends without one terminal finish', async () => {
    const output = createProposal('Must not survive malformed EOF')
    const { ctx, service, consolidator } = await setup([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: output },
    ]])

    appendCompletedTurn(
      ctx,
      'auto-malformed-stream',
      1,
      'Do not accept a partial model stream.',
      'A terminal finish is required.',
    )
    await consolidator.whenIdle()

    expect(service.listCandidates()).toEqual([])
    expect(service.metrics().backgroundTaskFailures).toBe(1)
    expect(service.listAudit().some(row => row.action === 'consolidation.request')).toBe(true)
    expect(service.listAudit().some(row => row.action === 'consolidation.complete')).toBe(false)
  })

  it('ignores model reasoning blocks and parses only the final text block', async () => {
    const output = createProposal('Reasoning stays ephemeral')
    const { ctx, service, consolidator } = await setup([[
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'PRIVATE-REASONING-MUST-NOT-PERSIST' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE-REASONING-MUST-NOT-PERSIST' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: output },
      { type: 'block-end', index: 1, block: { type: 'text', text: output } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])

    appendCompletedTurn(
      ctx,
      'auto-reasoning-output',
      1,
      'Keep hidden model reasoning out of durable memory.',
      'Only strict JSON text becomes a candidate.',
    )
    await consolidator.whenIdle()

    expect(service.listCandidates()).toHaveLength(1)
    expect(JSON.stringify(service.listCandidates())).not.toContain('PRIVATE-REASONING-MUST-NOT-PERSIST')
    expect(JSON.stringify(service.listAudit())).not.toContain('PRIVATE-REASONING-MUST-NOT-PERSIST')
  })

  it('enforces the aggregate output limit across block-end-only output', async () => {
    const oversized = 'x'.repeat(550_000)
    const { ctx, service, consolidator } = await setup([[
      { type: 'block-end', index: 0, block: { type: 'text', text: oversized } },
      { type: 'block-end', index: 1, block: { type: 'text', text: oversized } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])

    appendCompletedTurn(
      ctx,
      'auto-output-limit',
      1,
      'Reject oversized auxiliary output.',
      'The aggregate block size must be bounded.',
    )
    await consolidator.whenIdle()

    expect(service.listCandidates()).toEqual([])
    expect(service.metrics().backgroundTaskFailures).toBe(1)
  })

  it('allows an update only against a supplied same-workspace record and pins its revision', async () => {
    const { ctx, adapter, service, consolidator } = await setup([])
    const seed = service.propose({
      content: draft({ scope: { type: 'workspace', key: home!.root } }),
      actor: { kind: 'migration', id: 'seed' },
      now: 1_000,
    })
    service.review(seed.id, {
      action: 'publish',
      actor: reviewer,
      reason: 'Seed evidence checked.',
      now: 2_000,
    })
    const record = service.listRecords()[0]!
    const output = JSON.stringify({
      proposals: [{
        operation: 'update',
        targetMemoryId: record.memoryId,
        kind: 'procedural',
        subject: record.subject,
        applicability: record.applicability,
        action: 'Abort and await queued consolidation calls before releasing the database.',
        rationale: 'Waiting for quiescence prevents a late candidate write after plugin unload.',
        confidence: 0.93,
      }],
    })
    adapter.outputs.push(output)

    appendCompletedTurn(
      ctx,
      'auto-update',
      1,
      'Refine the shutdown rule for automatic memory consolidation.',
      'Shutdown now aborts and awaits every queued auxiliary request.',
      undefined,
      undefined,
      `${home!.root}${sep}nonexistent-child${sep}..`,
    )
    await consolidator.whenIdle()

    const candidates = service.listCandidates()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      operation: 'update',
      targetMemoryId: record.memoryId,
      expectedRevision: record.revision,
      status: 'candidate',
    })
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain(record.memoryId)
    expect(service.listRecords()[0]?.revision).toBe(record.revision)
  })

  it('rejects model-selected update targets that were not supplied in the bounded context', async () => {
    const { ctx, service, consolidator } = await setup([JSON.stringify({
      proposals: [{
        operation: 'update',
        targetMemoryId: 'memory-out-of-scope',
        kind: 'semantic',
        subject: 'Untrusted target',
        applicability: 'Always.',
        action: 'Overwrite an unrelated memory.',
        rationale: 'This must be rejected.',
        confidence: 1,
      }],
    })])

    appendCompletedTurn(ctx, 'auto-invalid-target', 1, 'Summarize this.', 'No related memory exists.')
    await consolidator.whenIdle()

    expect(service.listCandidates()).toEqual([])
    expect(service.metrics().backgroundTaskFailures).toBe(1)
  })

  it('cancels active work when its source session is disposed', async () => {
    home = temporaryMemoryHome({
      autoConsolidate: true,
      consolidationTimeoutMs: 60_000,
      markdownProjection: false,
    })
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionPersistence', {} as never)
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.on('session/flush', () => undefined)
    const adapter = new BlockingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    new MemoryService(ctx, home.config)
    const consolidator = new AutomaticMemoryConsolidator(ctx, home.config)
    consolidator.start()
    const id = SessionId('auto-session-dispose')
    const session = ctx.sessions.prepare(id, { meta: { cwd: home.root } })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)

    appendCompletedTurn(ctx, String(id), 1, 'Remember session disposal.', 'The source session is ending.')
    await adapter.started
    detach()
    await consolidator.whenIdle()

    expect(adapter.aborted).toBe(true)
  })

  it('does not let a non-settling flush provider block plugin disposal', { timeout: 5_000 }, async () => {
    const { ctx, adapter } = await setup([createProposal('Never dispatched')], {}, false)
    let markFlushStarted: () => void = () => undefined
    const flushStarted = new Promise<void>(resolve => {
      markFlushStarted = resolve
    })
    ctx.on('session/flush', () => {
      markFlushStarted()
      return new Promise<void>(() => undefined)
    })

    appendCompletedTurn(
      ctx,
      'auto-blocked-flush',
      1,
      'The persistence provider does not settle.',
      'Plugin-owned teardown must still complete.',
    )
    await flushStarted
    await ctx.fiber.dispose()

    expect(adapter.requests).toEqual([])
  })

  it('drains an in-flight AI review before the owning service closes SQLite', async () => {
    home = temporaryMemoryHome({
      autoConsolidate: true,
      aiReviewMode: 'enforce',
      reviewProvider: 'review',
      reviewModel: 'review-model',
      consolidationTimeoutMs: 60_000,
      reviewTimeoutMs: 60_000,
      markdownProjection: false,
    })
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionPersistence', {} as never)
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.on('session/flush', () => undefined)
    const adapter = new ReviewBlockingAdapter()
    ctx.llm.registerAdapter(['mock', 'review'], adapter)
    const service = new MemoryService(ctx, home.config)
    const close = service.store.close.bind(service.store)
    const closeSpy = vi.spyOn(service.store, 'close').mockImplementation(() => {
      expect(adapter.reviewAborted).toBe(true)
      close()
    })
    const consolidator = new AutomaticMemoryConsolidator(ctx, home.config)
    ctx.effect(() => consolidator.start())

    appendCompletedTurn(ctx, 'auto-review-dispose', 1, 'Review before shutdown.', 'The review is still running.')
    await adapter.reviewStarted
    await ctx.fiber.dispose()

    expect(adapter.reviewAborted).toBe(true)
    expect(closeSpy).toHaveBeenCalledOnce()
    await consolidator.whenIdle()
  })

  it('aborts and awaits an active request during disposal', async () => {
    home = temporaryMemoryHome({
      autoConsolidate: true,
      consolidationTimeoutMs: 60_000,
      markdownProjection: false,
    })
    const ctx = new Context()
    context = ctx
    ctx.provide('sessionPersistence', {} as never)
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.on('session/flush', () => undefined)
    const adapter = new BlockingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    new MemoryService(ctx, home.config)
    const consolidator = new AutomaticMemoryConsolidator(ctx, home.config)
    const dispose = consolidator.start()

    appendCompletedTurn(ctx, 'auto-dispose', 1, 'Remember the shutdown behavior.', 'The request is still running.')
    await adapter.started
    await dispose()

    expect(adapter.aborted).toBe(true)
    await consolidator.whenIdle()
  })
})
