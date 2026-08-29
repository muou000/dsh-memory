import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import type { Config, ResolvedConfig } from '../src/config.ts'
import type { MemoryContent } from '../src/types.ts'

export interface TemporaryMemoryHome {
  readonly root: string
  readonly config: ResolvedConfig
  cleanup(): void
}

export function temporaryMemoryHome(overrides: Config = {}): TemporaryMemoryHome {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-spec-'))
  const config = resolveConfig({ dshHome: root, ...overrides }, {})
  return {
    root,
    config,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function draft(overrides: Partial<MemoryContent> = {}): MemoryContent {
  return {
    kind: 'procedural',
    scope: { type: 'workspace', key: 'D:\\work\\alpha' },
    subject: 'Stop hook reporting must not block shutdown',
    applicability: 'When reporting telemetry from the stop hook in repository alpha.',
    action: 'Queue the report asynchronously and let shutdown continue.',
    rationale: 'Synchronous reporting can block the process and cause cascading timeouts.',
    confidence: 0.92,
    sensitivity: 'internal',
    owner: 'platform-team',
    evidence: [{ kind: 'test', locator: 'tests/stop-hook.spec.ts#non-blocking' }],
    ...overrides,
  }
}

export const reviewer = { kind: 'human' as const, id: 'reviewer@example' }
export const proposer = { kind: 'agent' as const, id: 'session-alpha' }
