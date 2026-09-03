import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { CallId, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { load as loadYaml } from 'js-yaml'
import * as memory from '../src/index.ts'
import { draft, reviewer } from './helpers.ts'

let root: string | undefined
let context: Context | undefined
const PACKAGE_NAME = '@muou000/dsh-memory'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const source = options.messages[0]?.source
    const text = source?.kind === 'plugin' && source.plugin === 'dsh-memory/consolidator'
      ? JSON.stringify({
          proposals: [{
            operation: 'create',
            kind: 'semantic',
            subject: 'Loader automatic memory candidate',
            applicability: 'When running dsh-memory through the real Loader composition.',
            action: 'Queue a review candidate after a completed turn.',
            rationale: 'The durable turn boundary supplies a stable asynchronous trigger.',
            confidence: 0.9,
          }],
        })
      : source?.kind === 'plugin' && source.plugin === 'dsh-memory/reviewer'
        ? JSON.stringify({
            decisions: [{
              verdict: 'publish',
              reason: 'The source turn supports a durable and scoped workspace memory.',
              confidence: 0.97,
              checks: {
                grounded: true,
                durable: true,
                scopeCorrect: true,
                nonSensitive: true,
                useful: true,
                nonDuplicate: true,
                nonConflicting: true,
              },
            }],
          })
        : 'used governed memory'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class BlockingConsolidationAdapter extends LlmAdapter {
  readonly consolidationStarted: Promise<void>
  aborted = false
  private resolveStarted: () => void = () => undefined

  constructor() {
    super()
    this.consolidationStarted = new Promise<void>(resolve => {
      this.resolveStarted = resolve
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const source = options.messages[0]?.source
    if (source?.kind !== 'plugin' || source.plugin !== 'dsh-memory/consolidator') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'main response completed' }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const signal = options.signal
    if (signal === undefined) throw new Error('expected consolidation signal')
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

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(
  autoConsolidate = false,
  withSessionPersistence = true,
  aiReviewMode: 'off' | 'shadow' | 'enforce' = 'off',
): Promise<{ ctx: Context; workspace: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const workspace = join(root, 'workspace')
  const configPath = join(root, 'cordis.yml')
  const portableRoot = root.replaceAll('\\', '/')
  const patch = loadYaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as Array<{
    insert?: Array<{ id?: string; name?: string }>
  }>
  const row = patch.flatMap(operation => operation.insert ?? []).find(entry => entry.id === 'dsh-memory')
  expect(row).toMatchObject({ id: 'dsh-memory', name: PACKAGE_NAME })
  if (row?.name === undefined) throw new Error('cordis.patch.yml does not insert dsh-memory')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    `- name: '${row.name}'`,
    '  config:',
    `    dshHome: '${portableRoot}'`,
    '    injectionTokenBudget: 256',
    '    maxInjectedItems: 2',
    `    autoConsolidate: ${String(autoConsolidate)}`,
    `    aiReviewMode: ${aiReviewMode}`,
    ...(aiReviewMode === 'off' ? [] : [
      '    reviewProvider: review',
      '    reviewModel: review-model',
    ]),
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  if (withSessionPersistence) context.provide('sessionPersistence', {} as never)
  context.on('session/flush', () => undefined)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    [row.name, memory],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return { ctx: context, workspace }
}

describe('real Loader and agent-loop composition', () => {
  it('loads the default-off baseline without llm or sessions services', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-memory-minimal-'))
    context = new Context()
    await context.plugin(AgentRegistry)
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    await context.plugin(memory, {
      storagePath: join(root, 'memory.sqlite'),
      projectionPath: join(root, 'projection'),
      markdownProjection: false,
      autoConsolidate: false,
    })

    expect(context.memories.health.state).toBe('ready')
  })

  it('injects scoped knowledge into the model request and persists the recall in the session log', { timeout: 60_000 }, async () => {
    const { ctx, workspace } = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const candidate = ctx.memories.propose({
      content: draft({ scope: { type: 'workspace', key: workspace } }),
      actor: { kind: 'migration', id: 'loader-fixture' },
      now: 1_000,
    })
    const published = ctx.memories.review(candidate.id, {
      action: 'publish', actor: reviewer, reason: 'Loader fixture reviewed.', now: 2_000,
    })
    expect(published.publishedMemoryId).toBeDefined()
    const record = ctx.memories.listRecords()[0]!
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(
      SessionId('memory-loader'),
      { provider: 'mock', model: 'mock' },
      { cwd: workspace },
    )
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'How should stop hook telemetry behave during shutdown?' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const recall = adapter.requests[0]?.messages.find(message =>
      message.role === 'user'
      && message.source.kind === 'plugin'
      && message.source.plugin === 'dsh-memory')
    expect(recall).toBeDefined()
    expect(JSON.stringify(recall)).toContain(record.memoryId)
    expect(JSON.stringify(recall)).toContain('Queue the report asynchronously')
    const loggedRecall = agent.session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'dsh-memory')
    expect(loggedRecall).toBeDefined()
    expect(JSON.stringify(loggedRecall)).toContain(record.memoryId)
    expect(ctx.memories.listRecords()[0]).toMatchObject({ useCount: 1 })

    const search = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'memory-search-accounting' as CallId,
      name: 'memory_search',
      arguments: { query: 'stop hook telemetry', limit: 2 },
      agent,
    })
    const searchValue = search.value as {
      retrievalId: string
      selectedCount: number
      estimatedTokens: number
      context: string
    }
    expect(searchValue.selectedCount).toBe(1)
    expect(searchValue.estimatedTokens).toBeLessThanOrEqual(256)
    expect(searchValue.context).toContain(record.memoryId)

    const replayedSearch = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'memory-search-accounting' as CallId,
      name: 'memory_search',
      arguments: { query: 'stop hook telemetry', limit: 2 },
      agent,
    })
    expect((replayedSearch.value as { retrievalId: string }).retrievalId).toBe(searchValue.retrievalId)
    expect(ctx.memories.listRetrievals()).toHaveLength(2)

    const read = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'memory-read-accounting' as CallId,
      name: 'memory_read',
      arguments: { memoryId: record.memoryId, retrievalId: searchValue.retrievalId },
      agent,
    })
    expect(read.value).toMatchObject({ found: true, memoryId: record.memoryId })
    expect(ctx.memories.metrics()).toMatchObject({ retrievalCount: 2, selectedCount: 2, drillDownCount: 1 })
  })

  it('keeps automatic consolidation dormant when only a flush listener exists without persistence', { timeout: 60_000 }, async () => {
    const { ctx, workspace } = await loadComposition(true, false)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(
      SessionId('memory-loader-no-persistence'),
      { provider: 'mock', model: 'mock' },
      { cwd: workspace },
    )

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Do not consolidate without durable persistence.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(ctx.memories.health.state).toBe('ready')
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.memories.listCandidates()).toEqual([])
    expect(ctx.memories.listAudit().some(row => row.action === 'consolidation.request')).toBe(false)
  })

  it('creates an automatic review candidate through the real Loader and agent loop', { timeout: 60_000 }, async () => {
    const { ctx, workspace } = await loadComposition(true)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(
      SessionId('memory-loader-automatic'),
      { provider: 'mock', model: 'mock' },
      { cwd: workspace },
    )

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Capture durable project knowledge after this turn.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await vi.waitFor(() => {
      expect(ctx.memories.listCandidates()).toHaveLength(1)
    }, { timeout: 5_000 })

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toMatchObject({ provider: 'mock', model: 'mock' })
    expect(adapter.requests[1]?.messages[0]?.source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-memory/consolidator',
    })
    expect(ctx.memories.listRecords()).toEqual([])
    expect(ctx.memories.listCandidates()[0]).toMatchObject({
      status: 'candidate',
      content: {
        scope: { type: 'workspace', key: workspace },
        subject: 'Loader automatic memory candidate',
      },
    })
  })

  it('publishes through the configured AI reviewer in enforce mode via the real Loader', { timeout: 60_000 }, async () => {
    const { ctx, workspace } = await loadComposition(true, true, 'enforce')
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['mock', 'review'], adapter)
    const agent = ctx.agentLoop.create(
      SessionId('memory-loader-ai-review'),
      { provider: 'mock', model: 'mock' },
      { cwd: workspace },
    )

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Capture and review durable project knowledge after this turn.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await vi.waitFor(() => {
      expect(ctx.memories.listCandidates('published')).toHaveLength(1)
    }, { timeout: 5_000 })

    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[2]).toMatchObject({ provider: 'review', model: 'review-model', tools: [] })
    expect(ctx.memories.listRecords()).toHaveLength(1)
    expect(ctx.memories.listAudit().some(row => row.action === 'ai-review.complete')).toBe(true)
  })

  it('hot-unload aborts and drains an active automatic request before closing the store', { timeout: 60_000 }, async () => {
    const { ctx, workspace } = await loadComposition(true)
    const adapter = new BlockingConsolidationAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(
      SessionId('memory-loader-unload-active'),
      { provider: 'mock', model: 'mock' },
      { cwd: workspace },
    )
    const previous = ctx.memories
    const entry = [...ctx.loader.entries()].find(item => item.options.name === PACKAGE_NAME)
    expect(entry !== undefined).toBe(true)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Start an automatic consolidation request.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    await adapter.consolidationStarted
    await ctx.loader.update(entry!.id, { disabled: true })
    await ctx.loader.await()

    expect(adapter.aborted).toBe(true)
    expect(ctx.get('memories')).toBeUndefined()
    expect(() => previous.stats()).toThrow('store is closed')
  })

  it('hot-disables every registration and writer resource, then reloads the same store', { timeout: 60_000 }, async () => {
    const { ctx, workspace } = await loadComposition()
    const candidate = ctx.memories.propose({
      content: draft({ scope: { type: 'workspace', key: workspace } }),
      actor: { kind: 'migration', id: 'reload-fixture' },
      now: 1_000,
    })
    ctx.memories.review(candidate.id, {
      action: 'publish', actor: reviewer, reason: 'Reload fixture reviewed.', now: 2_000,
    })
    const previous = ctx.memories
    const entry = [...ctx.loader.entries()].find(item => item.options.name === PACKAGE_NAME)
    expect(entry !== undefined).toBe(true)
    expect(ctx.tools.get('memory_search') !== undefined).toBe(true)
    expect(ctx.tools.get('memory_read') !== undefined).toBe(true)
    expect(ctx.tools.get('memory_propose') !== undefined).toBe(true)
    expect(ctx.tools.get('memory_feedback') !== undefined).toBe(true)

    await ctx.loader.update(entry!.id, { disabled: true })
    await ctx.loader.await()
    expect(ctx.get('memories') === undefined).toBe(true)
    expect(ctx.tools.get('memory_search') === undefined).toBe(true)
    expect(ctx.tools.get('memory_read') === undefined).toBe(true)
    expect(ctx.tools.get('memory_propose') === undefined).toBe(true)
    expect(ctx.tools.get('memory_feedback') === undefined).toBe(true)
    expect(() => previous.stats()).toThrow('store is closed')

    await ctx.loader.update(entry!.id, { disabled: false })
    await ctx.loader.await()
    expect(ctx.memories.listRecords()).toHaveLength(1)
    expect(ctx.tools.get('memory_search') !== undefined).toBe(true)
  })
})
