import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import type { ResolvedConfig } from './config.ts'
import { renderMemoryContext } from './render.ts'
import type { MemoryAccessContext } from './types.ts'

/** Register replayable, scope-filtered automatic retrieval on DSH's public pre-step seam. */
export function registerMemoryConsumer(ctx: Context, config: ResolvedConfig): () => void {
  if (!config.autoInject) return () => undefined
  return ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.step !== 1 || payload.signal.aborted) return decision
    const query = taskText(payload.messages)
    if (query.length === 0) return decision

    const access = accessForAgent(payload.agent)
    let result
    try {
      result = ctx.memories.search(query, access, {
        limit: config.retrievalCandidateLimit,
        kinds: config.injectedKinds,
        includeEvidence: false,
      })
    } catch (error) {
      ctx.logger('dsh-memory').warn(
        'retrieval failed for session %s turn %d: %s',
        String(payload.agent.id),
        payload.turn,
        error instanceof Error ? error.message : String(error),
      )
      return decision
    }
    // The pre-step callback can be replayed after a restart. Derive the batch
    // id from stable session inputs so accounting and the model-visible header
    // identify the same retrieval event on a replay.
    const retrievalId = automaticRetrievalId(payload.agent, payload.turn, result.queryHash)
    const rendered = renderMemoryContext(result.hits, config, retrievalId)
    if (ctx.memories.writable) {
      try {
        ctx.memories.recordRetrieval({
          id: retrievalId,
          queryHash: result.queryHash,
          ...(config.logQueryText ? { queryText: query } : {}),
          context: access,
          candidateCount: result.candidateCount,
          selected: rendered.selected.map(hit => ({
            memoryId: hit.record.memoryId,
            revision: hit.record.revision,
            score: hit.score,
          })),
          tokenBudget: config.injectionTokenBudget,
          estimatedTokens: rendered.estimatedTokens,
          durationMs: result.durationMs,
          sessionId: String(payload.agent.id),
          turn: payload.turn,
        })
      } catch (error) {
        ctx.logger('dsh-memory').warn(
          'retrieval accounting failed for session %s turn %d: %s',
          String(payload.agent.id),
          payload.turn,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (rendered.text.length === 0) return decision

    const contextMessage = createUserMessage({
      content: [{ type: 'text' as const, text: rendered.text }],
      source: { kind: 'plugin' as const, plugin: 'dsh-memory', form: 'recall' as const },
    })
    return { ...decision, messages: [contextMessage, ...decision.messages] }
  })
}

export function accessForAgent(agent: {
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string } }
}): MemoryAccessContext {
  return Object.freeze({
    ...(agent.session.header.cwd === undefined ? {} : { workspace: agent.session.header.cwd }),
    session: String(agent.id),
    agent: String(agent.id),
    includeGlobal: true,
    maxSensitivity: 'internal',
  })
}

function taskText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n').trim().slice(0, 20_000)
}

function automaticRetrievalId(
  agent: { readonly id: string; readonly session: { readonly header: { readonly cwd?: string } } },
  turn: number,
  queryHashValue: string,
): string {
  const digest = createHash('sha256')
    .update(`${String(agent.id)}\u0000${String(agent.session.header.cwd ?? '')}\u0000${turn}\u0000${queryHashValue}`, 'utf8')
    .digest('hex')
  return `auto-${digest}`
}
