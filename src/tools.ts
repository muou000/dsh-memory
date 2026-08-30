import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import type { ResolvedConfig } from './config.ts'
import { accessForAgent } from './consumer.ts'
import { renderMemoryContext, renderMemoryDetail } from './render.ts'
import type { EvidenceReference, MemoryKind } from './types.ts'

const SEARCH_OUTPUT = {
  type: 'object' as const,
  properties: {
    retrievalId: { type: 'string' as const },
    queryHash: { type: 'string' as const },
    candidateCount: { type: 'integer' as const },
    selectedCount: { type: 'integer' as const },
    estimatedTokens: { type: 'integer' as const },
    context: { type: 'string' as const },
  },
  additionalProperties: false,
}

/** Register least-authority model tools: search, read, propose, and feedback. */
export function registerMemoryTools(ctx: Context, config: ResolvedConfig): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      ctx.tools.register(defineTool({
      name: 'memory_search',
      description: 'Search verified project knowledge visible to the current workspace. Use when prior project-specific facts, constraints, locations, or failure lessons may help.',
      parameters: {
        query: { type: 'string', required: true, description: 'Specific fact, component, constraint, or problem to find.' },
        limit: { type: 'integer', description: 'Maximum results, from 1 to 10.' },
      },
      output: {
        schema: SEARCH_OUTPUT,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const agent = requireAgent(exec.agent)
        const limit = args.limit ?? 6
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be an integer in [1, 10]')
        const result = ctx.memories.search(args.query, accessForAgent(agent), {
          limit,
          includeEvidence: false,
          kinds: config.injectedKinds,
        })
        const retrievalId = toolRetrievalId(agent, exec.rootCallId, result.queryHash)
        const rendered = renderMemoryContext(result.hits, {
          maxInjectedItems: Math.min(limit, config.maxInjectedItems),
          injectionTokenBudget: config.injectionTokenBudget,
          maxRenderedItemChars: config.maxRenderedItemChars,
        }, retrievalId)
        if (ctx.memories.writable) {
          try {
            ctx.memories.recordRetrieval({
              id: retrievalId,
              queryHash: result.queryHash,
              ...(config.logQueryText ? { queryText: args.query } : {}),
              context: accessForAgent(agent),
              candidateCount: result.candidateCount,
              selected: rendered.selected.map(hit => ({
                memoryId: hit.record.memoryId,
                revision: hit.record.revision,
                score: hit.score,
              })),
              tokenBudget: config.injectionTokenBudget,
              estimatedTokens: rendered.estimatedTokens,
              durationMs: result.durationMs,
              sessionId: String(agent.id),
            })
          } catch {
            ctx.logger('dsh-memory').error(
              'stage=tool-search-accounting outcome=error retrieval_id=%s code=accounting_failed',
              retrievalId,
            )
          }
        }
        return {
          retrievalId,
          queryHash: result.queryHash,
          candidateCount: result.candidateCount,
          selectedCount: rendered.selected.length,
          estimatedTokens: rendered.estimatedTokens,
          context: rendered.text,
        }
      },
      })),
    )
    disposers.push(
      ctx.tools.register(defineTool({
      name: 'memory_read',
      description: 'Read one visible verified memory with rationale and evidence locators before relying on a consequential claim.',
      parameters: {
        memoryId: { type: 'string', required: true, description: 'Memory id returned by memory_search or an injected reference.' },
        retrievalId: { type: 'string', description: 'Retrieval batch that selected this memory, when available.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean' },
            memoryId: { type: 'string' },
            revision: { type: 'integer' },
            detail: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.found ? value.detail ?? '' : 'Memory not found or not visible.' }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const agent = requireAgent(exec.agent)
        const record = ctx.memories.get(args.memoryId, accessForAgent(agent), true)
        if (record === undefined) return { found: false }
        // Render before recording usage so a budget/configuration failure does
        // not claim that an unreadable detail was delivered to the model.
        const detail = renderMemoryDetail(record, config.drillDownTokenBudget)
        if (ctx.memories.writable) {
          try {
            ctx.memories.recordRead({
              memoryId: record.memoryId,
              revision: record.revision,
              actor: { kind: 'agent', id: String(agent.id) },
              ...(args.retrievalId === undefined ? {} : { retrievalId: args.retrievalId }),
            })
          } catch {
            ctx.logger('dsh-memory').error(
              'stage=tool-read-accounting outcome=error memory_id=%s code=accounting_failed',
              record.memoryId,
            )
          }
        }
        return {
          found: true,
          memoryId: record.memoryId,
          revision: record.revision,
          detail,
        }
      },
      })),
    )
    disposers.push(
      ctx.tools.register(defineTool({
      name: 'memory_propose',
      description: 'Propose a project-specific reusable fact, hidden location, constraint, or verified lesson for human review. This never publishes knowledge directly. Do not submit general advice, raw transcripts, secrets, or one-off task state.',
      parameters: {
        kind: { type: 'string', enum: ['episodic', 'semantic', 'procedural'], required: true },
        subject: { type: 'string', required: true, description: 'Short human-readable title.' },
        applicability: { type: 'string', required: true, description: 'Exact conditions and boundaries where the knowledge applies.' },
        action: { type: 'string', required: true, description: 'Specific fact, action, warning, or decision to use.' },
        rationale: { type: 'string', required: true, description: 'Mechanism, consequence, or evidence-backed reason.' },
        confidence: { type: 'number', description: 'Confidence from 0 to 1; default 0.7.' },
        sourceKind: { type: 'string', enum: ['file', 'commit', 'test', 'url'], description: 'Optional additional evidence type.' },
        sourceLocator: { type: 'string', description: 'Optional stable file, commit, test, or URL locator.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            candidateId: { type: 'string' },
            status: { type: 'string' },
            exactDuplicateId: { type: 'string' },
            similarMemoryIds: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.status === 'candidate'
          ? `Knowledge candidate ${value.candidateId} is awaiting human review.`
          : `Knowledge proposal was ${value.status}${value.exactDuplicateId === undefined ? '.' : ` as duplicate of ${value.exactDuplicateId}.`}` }],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const agent = requireAgent(exec.agent)
        if (!ctx.memories.writable) throw new Error('memory store is read-only')
        const cwd = agent.session.header.cwd
        if (cwd === undefined) throw new Error('current session has no workspace path; scoped proposal is unavailable')
        const evidence: EvidenceReference[] = [{
          kind: 'session-event',
          locator: `session:${String(agent.id)};through-seq:${Math.max(0, agent.session.seq - 1)}`,
        }]
        if (args.sourceKind !== undefined || args.sourceLocator !== undefined) {
          if (args.sourceKind === undefined || args.sourceLocator === undefined) {
            throw new Error('sourceKind and sourceLocator must be provided together')
          }
          evidence.push({ kind: args.sourceKind, locator: args.sourceLocator })
        }
        const candidate = ctx.memories.propose({
          content: {
            kind: args.kind as MemoryKind,
            scope: { type: 'workspace', key: cwd },
            subject: args.subject,
            applicability: args.applicability,
            action: args.action,
            rationale: args.rationale,
            confidence: args.confidence ?? 0.7,
            sensitivity: 'internal',
            owner: `agent:${String(agent.id)}`,
            evidence,
          },
          actor: { kind: 'agent', id: String(agent.id) },
          requestId: `tool:${String(exec.rootCallId)}`,
        })
        return {
          candidateId: candidate.id,
          status: candidate.status,
          similarMemoryIds: [...candidate.similarMemoryIds],
          ...(candidate.exactDuplicateId === undefined ? {} : { exactDuplicateId: candidate.exactDuplicateId }),
        }
      },
      })),
    )
    disposers.push(
      ctx.tools.register(defineTool({
      name: 'memory_feedback',
      description: 'Report whether a retrieved memory was helpful, harmful, irrelevant, or stale. Feedback affects review and ranking but never rewrites the memory.',
      parameters: {
        memoryId: { type: 'string', required: true },
        revision: { type: 'integer', required: true },
        kind: { type: 'string', enum: ['helpful', 'harmful', 'irrelevant', 'stale'], required: true },
        retrievalId: { type: 'string', description: 'Retrieval batch id shown in the injected knowledge block, when available.' },
        note: { type: 'string', description: 'Short evidence-based reason without secrets.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { recorded: { type: 'boolean' } },
        },
        render: () => [{ type: 'text', text: 'Memory feedback recorded.' }],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const agent = requireAgent(exec.agent)
        if (!ctx.memories.writable) throw new Error('memory store is read-only')
        const visible = ctx.memories.get(args.memoryId, accessForAgent(agent), false)
        if (visible === undefined || visible.revision !== args.revision) {
          throw new Error('memory is not visible or revision is not current')
        }
        ctx.memories.feedback({
          id: toolFeedbackId(agent, exec.rootCallId, args.memoryId, args.revision, args.kind),
          memoryId: args.memoryId,
          revision: args.revision,
          kind: args.kind,
          actor: { kind: 'agent', id: String(agent.id) },
          ...(args.retrievalId === undefined ? {} : { retrievalId: args.retrievalId }),
          ...(args.note === undefined ? {} : { note: args.note }),
        })
        return { recorded: true }
      },
      })),
    )
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function requireAgent<T>(agent: T | undefined): T & {
  readonly id: string
  readonly session: {
    readonly header: { readonly cwd?: string }
    readonly seq: number
  }
} {
  if (agent === undefined) throw new Error('memory tool requires an agent context')
  return agent as T & {
    readonly id: string
    readonly session: { readonly header: { readonly cwd?: string }; readonly seq: number }
  }
}

/** Keep tool retrieval accounting stable when a logged tool call is replayed. */
function toolRetrievalId(
  agent: { readonly id: string; readonly session: { readonly header: { readonly cwd?: string } } },
  rootCallId: unknown,
  queryHashValue: string,
): string {
  const digest = createHash('sha256')
    .update(`${String(agent.id)}\u0000${String(agent.session.header.cwd ?? '')}\u0000${String(rootCallId)}\u0000${queryHashValue}`, 'utf8')
    .digest('hex')
  return `tool-${digest}`
}

function toolFeedbackId(
  agent: { readonly id: string },
  rootCallId: unknown,
  memoryId: string,
  revision: number,
  kind: string,
): string {
  const digest = createHash('sha256')
    .update(`${String(agent.id)}\u0000${String(rootCallId)}\u0000${memoryId}\u0000${revision}\u0000${kind}`, 'utf8')
    .digest('hex')
  return `feedback-${digest}`
}
