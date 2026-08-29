/** Governed, replayable team knowledge for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import { ConfigSchema, resolveConfig } from './config.ts'
import type { Config as MemoryConfig } from './config.ts'
import { registerMemoryConsumer } from './consumer.ts'
import { MemoryService } from './service.ts'
import { registerMemoryTools } from './tools.ts'

export { resolveConfig, ConfigSchema } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { createDatabaseBackup, restoreDatabaseBackup, validateDatabaseFile } from './backup.ts'
export { containsSecret, contentHash, normalizeAccessContext, normalizeContent, queryHash } from './content.ts'
export { MarkdownProjection } from './projection.ts'
export { estimateTokens, renderMemoryContext, renderMemoryDetail } from './render.ts'
export { MemoryService } from './service.ts'
export { MemoryStore, fingerprint } from './store.ts'
export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-memory'

/** User-configurable plugin options. */
export type Config = MemoryConfig

/** Runtime configuration schema. Cross-field constraints are enforced by `resolveConfig`. */
export const Config = ConfigSchema

/** Required public DSH services. */
export const inject = ['agents', 'tools']

/** Mount the memory service, model tools, and replayable retrieval consumer. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  new MemoryService(ctx, resolved)
  ctx.effect(() => registerMemoryTools(ctx, resolved))
  ctx.effect(() => registerMemoryConsumer(ctx, resolved))
  if (resolved.logLifecycle) {
    ctx.effect(() => {
      ctx.logger('dsh-memory').info('loaded store=%s projection=%s', resolved.storagePath, resolved.projectionPath)
      return () => ctx.logger('dsh-memory').info('unloaded')
    })
  }
}
