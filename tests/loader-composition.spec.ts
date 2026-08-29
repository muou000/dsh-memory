import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as memory from '../src/index.ts'
import { draft, reviewer } from './helpers.ts'

let root: string | undefined
let context: Context | undefined

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'used governed memory' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'used governed memory' } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; workspace: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const workspace = join(root, 'workspace')
  const configPath = join(root, 'cordis.yml')
  const portableRoot = root.replaceAll('\\', '/')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: 'dsh-memory'",
    '  config:',
    `    dshHome: '${portableRoot}'`,
    '    injectionTokenBudget: 256',
    '    maxInjectedItems: 2',
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['dsh-memory', memory],
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
  })
})
