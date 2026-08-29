import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import { accessForAgent } from './consumer.ts'
import { renderMemoryDetail } from './render.ts'
import type { EvidenceReference, MemoryKind } from './types.ts'

const SEARCH_OUTPUT = {
  type: 'object' as const,
  properties: {
    queryHash: { type: 'string' as const },
    hits: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          memoryId: { type: 'string' as const },
          revision: { type: 'integer' as const },
          subject: { type: 'string' as const },
          applicability: { type: 'string' as const },
          action: { type: 'string' as const },
          score: { type: 'number' as const },
        },
      },
    },
  },
  additionalProperties: false,
}

/** Register least-authority model tools: search, read, propose, and feedback. */
export function registerMemoryTools(ctx: Context, config: ResolvedConfig): () => void {
  const disposers = [
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
        return {
          queryHash: result.queryHash,
          hits: result.hits.map(hit => ({
            memoryId: hit.record.memoryId,
            revision: hit.record.revision,
            subject: hit.record.subject,
            applicability: hit.record.applicability,
            action: hit.record.action,
            score: hit.score,
          })),
        }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'memory_read',
      description: 'Read one visible verified memory with rationale and evidence locators before relying on a consequential claim.',
      parameters: {
        memoryId: { type: 'string', required: true, description: 'Memory id returned by memory_search or an injected reference.' },
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
        return {
          found: true,
          memoryId: record.memoryId,
          revision: record.revision,
          detail: renderMemoryDetail(record),
        }
      },
    })),
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
          observedAt: Date.now(),
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
          ...(candidate.exactDuplicateId === undefined ? {} : { exactDuplicateId: candidate.exactDuplicateId }),
        }
      },
    })),
    ctx.tools.register(defineTool({
      name: 'memory_feedback',
      description: 'Report whether a retrieved memory was helpful, harmful, irrelevant, or stale. Feedback affects review and ranking but never rewrites the memory.',
      parameters: {
        memoryId: { type: 'string', required: true },
        revision: { type: 'integer', required: true },
        kind: { type: 'string', enum: ['helpful', 'harmful', 'irrelevant', 'stale'], required: true },
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
          memoryId: args.memoryId,
          revision: args.revision,
          kind: args.kind,
          actor: { kind: 'agent', id: String(agent.id) },
          ...(args.note === undefined ? {} : { note: args.note }),
        })
        return { recorded: true }
      },
    })),
  ]
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
