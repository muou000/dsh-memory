import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import type { MemoryStore } from './store.ts'
import type {
  MemoryCandidate,
  MemoryConflict,
  MemoryMaintenanceResult,
  MemoryRecord,
  MemoryRevision,
} from './types.ts'

const MANIFEST = '.dsh-memory-manifest.json'
const MANIFEST_FORMAT = 'dsh-memory-markdown-projection'
const MANIFEST_VERSION = 2

interface ProjectionManifest {
  readonly format: typeof MANIFEST_FORMAT
  readonly version: typeof MANIFEST_VERSION
  readonly generation: string
  readonly files: Readonly<Record<string, string>>
}

export interface ProjectionVerification {
  readonly valid: boolean
  readonly generation?: string
  readonly fileCount: number
  readonly errors: readonly string[]
}

/** Content-addressed publication work performed for one projection generation. */
export interface ProjectionPublication {
  readonly mode: 'full' | 'incremental'
  readonly writtenFiles: number
  readonly reusedFiles: number
  readonly removedFiles: number
  readonly totalFiles: number
}

/** Rebuildable Markdown view for humans. Canonical state always remains in SQLite. */
export class MarkdownProjection {
  readonly path: string

  constructor(private readonly config: ResolvedConfig) {
    this.path = config.projectionPath
  }

  rebuild(store: MemoryStore, nowInput?: number): ProjectionPublication {
    if (!this.config.markdownProjection || this.config.readOnly) return emptyPublication('full')
    ensureDirectory(this.path)
    ensureDirectory(join(this.path, 'records'))
    ensureDirectory(join(this.path, 'review'))

    const records = store.listRecords(['active', 'conflicted', 'stale', 'archived'])
    const candidates = store.listCandidates('candidate')
    const conflicts = store.listConflicts('open')
    const allConflicts = [...conflicts, ...store.listConflicts('resolved')]
    const now = nowInput ?? Date.now()
    const maintenance = store.maintenance({ now }, records.filter(record => record.status === 'active'))
    const revisions = new Map<string, MemoryRevision[]>()
    for (const revision of store.listRevisions()) {
      const group = revisions.get(revision.memoryId) ?? []
      group.push(revision)
      revisions.set(revision.memoryId, group)
    }
    const conflictsByMemory = new Map<string, MemoryConflict[]>()
    for (const conflict of allConflicts) {
      for (const memoryId of new Set([conflict.leftMemoryId, conflict.rightMemoryId])) {
        const group = conflictsByMemory.get(memoryId) ?? []
        group.push(conflict)
        conflictsByMemory.set(memoryId, group)
      }
    }

    const generated = new Map<string, string>()
    for (const record of records) {
      const relative = `records/${safeFileName(record.memoryId)}.md`
      generated.set(relative, renderRecord(
        record,
        revisions.get(record.memoryId) ?? [],
        conflictsByMemory.get(record.memoryId) ?? [],
        now,
      ))
    }
    generated.set('README.md', renderIndex(records, candidates, conflicts, maintenance, now))
    generated.set('review/candidates.md', renderCandidates(candidates))
    generated.set('review/conflicts.md', renderConflicts(conflicts, records))
    generated.set('review/expiring.md', renderMaintenance(maintenance))

    const old = readManifest(this.path)
    let writtenGeneratedFiles = 0
    for (const [relative, content] of generated) {
      if (atomicWriteIfChanged(join(this.path, relative), content)) writtenGeneratedFiles += 1
    }
    // The manifest is normally the ownership record. If it was lost or
    // corrupted, recover ownership from the two plugin-managed subdirectories
    // as well; otherwise a purged record page could survive indefinitely.
    const oldFiles = new Set([...old.files, ...managedProjectionFiles(this.path)])
    const stale = [...oldFiles].filter(relative => !generated.has(relative)).sort()
    let tombstonesWritten = 0
    for (const relative of stale) {
      if (atomicWriteIfChanged(join(this.path, relative), removedProjectionContent())) tombstonesWritten += 1
    }
    const manifest = createManifest(generated)

    // The manifest is the generation commit marker. A crash before this write
    // leaves the previous generation detectable instead of blessing mixed files.
    atomicWriteIfChanged(join(this.path, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const relative of stale) removeGeneratedFile(this.path, relative)

    const errors = verifyIncrementalPublication(this.path, manifest, new Set(), new Set(stale))
    if (errors.length > 0) {
      throw new Error(`dsh-memory projection verification failed: ${errors.join('; ')}`)
    }
    return Object.freeze({
      mode: 'full',
      writtenFiles: writtenGeneratedFiles + tombstonesWritten,
      reusedFiles: generated.size - writtenGeneratedFiles,
      removedFiles: stale.length,
      totalFiles: generated.size,
    })
  }

  /**
   * Publish known canonical record changes without rewriting every record page.
   * An invalid prior generation falls back to a fully verified rebuild.
   */
  refresh(store: MemoryStore, recordIdsInput: readonly string[], nowInput?: number): ProjectionPublication {
    if (!this.config.markdownProjection || this.config.readOnly) return emptyPublication('incremental')
    if (!Array.isArray(recordIdsInput) || recordIdsInput.some(id => typeof id !== 'string' || id.length === 0)) {
      throw new Error('dsh-memory projection recordIds must be a list of non-empty strings')
    }
    ensureDirectory(this.path)
    ensureDirectory(join(this.path, 'records'))
    ensureDirectory(join(this.path, 'review'))

    const old = readManifest(this.path)
    if (projectionBaseErrors(this.path, old).length > 0 || old.manifest === undefined) {
      return this.rebuild(store, nowInput)
    }

    const recordIds = [...new Set(recordIdsInput)]
    const records = store.listRecords(['active', 'conflicted', 'stale', 'archived'])
    const recordsById = new Map(records.map(record => [record.memoryId, record]))
    const candidates = store.listCandidates('candidate')
    const conflicts = store.listConflicts('open')
    const allConflicts = [...conflicts, ...store.listConflicts('resolved')]
    const now = nowInput ?? Date.now()
    const maintenance = store.maintenance({ now }, records.filter(record => record.status === 'active'))
    const generated = new Map<string, string>([
      ['README.md', renderIndex(records, candidates, conflicts, maintenance, now)],
      ['review/candidates.md', renderCandidates(candidates)],
      ['review/conflicts.md', renderConflicts(conflicts, records)],
      ['review/expiring.md', renderMaintenance(maintenance)],
    ])
    const removed = new Set<string>()
    for (const memoryId of recordIds) {
      const relative = `records/${safeFileName(memoryId)}.md`
      const record = recordsById.get(memoryId)
      if (record === undefined) {
        removed.add(relative)
        continue
      }
      generated.set(relative, renderRecord(
        record,
        store.listRevisions(memoryId),
        allConflicts.filter(conflict => conflict.leftMemoryId === memoryId || conflict.rightMemoryId === memoryId),
        now,
      ))
    }

    const nextFiles: Record<string, string> = { ...old.manifest.files }
    const checked = new Set<string>()
    let writtenGeneratedFiles = 0
    for (const [relative, content] of generated) {
      if (atomicWriteIfChanged(join(this.path, relative), content)) writtenGeneratedFiles += 1
      nextFiles[relative] = contentHash(content)
      checked.add(relative)
    }
    let tombstonesWritten = 0
    let removedFiles = 0
    for (const relative of removed) {
      if (!(relative in nextFiles) && !pathExists(join(this.path, relative))) continue
      removedFiles += 1
      if (atomicWriteIfChanged(join(this.path, relative), removedProjectionContent())) tombstonesWritten += 1
      delete nextFiles[relative]
    }
    const manifest = createManifestFromHashes(nextFiles)
    atomicWriteIfChanged(join(this.path, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const relative of removed) removeGeneratedFile(this.path, relative)

    const errors = verifyIncrementalPublication(this.path, manifest, checked, removed)
    if (errors.length > 0) {
      throw new Error(`dsh-memory projection verification failed: ${errors.join('; ')}`)
    }
    return Object.freeze({
      mode: 'incremental',
      writtenFiles: writtenGeneratedFiles + tombstonesWritten,
      reusedFiles: Object.keys(nextFiles).length - writtenGeneratedFiles,
      removedFiles,
      totalFiles: Object.keys(nextFiles).length,
    })
  }

  verify(): ProjectionVerification {
    const loaded = readManifest(this.path)
    const errors = [...validateProjectionLayout(this.path), ...loaded.errors]
    if (loaded.manifest !== undefined) {
      const expectedGeneration = generationHash(loaded.manifest.files)
      if (loaded.manifest.generation !== expectedGeneration) errors.push('manifest generation hash mismatch')
      const managed = new Set(managedProjectionFiles(this.path))
      for (const relative of managed) {
        if (!(relative in loaded.manifest.files)) errors.push(`unexpected generated projection file: ${relative}`)
      }
      for (const [relative, expectedHash] of Object.entries(loaded.manifest.files)) {
        if (!isSafeRelative(relative)) {
          errors.push(`unsafe manifest path: ${relative}`)
          continue
        }
        const path = join(this.path, relative)
        try {
          const stat = lstatSync(path)
          if (stat.isSymbolicLink() || !stat.isFile()) {
            errors.push(`projection entry is not a regular file: ${relative}`)
            continue
          }
          const actualHash = contentHash(readFileSync(path))
          if (actualHash !== expectedHash) errors.push(`projection content hash mismatch: ${relative}`)
        } catch {
          errors.push(`projection file missing: ${relative}`)
        }
      }
    }
    return Object.freeze({
      valid: errors.length === 0 && loaded.manifest !== undefined,
      ...(loaded.manifest === undefined ? {} : { generation: loaded.manifest.generation }),
      fileCount: loaded.files.length,
      errors: Object.freeze(errors),
    })
  }
}

function renderIndex(
  records: readonly MemoryRecord[],
  candidates: readonly MemoryCandidate[],
  conflicts: readonly MemoryConflict[],
  maintenance: MemoryMaintenanceResult,
  now: number,
): string {
  const lines = [
    '# Team knowledge',
    '',
    '> Generated by dsh-memory from the canonical store. Do not edit this projection.',
    '',
    `- Active: ${records.filter(record => record.status === 'active').length}`,
    `- Stale: ${records.filter(record => record.status === 'stale').length}`,
    `- Archived: ${records.filter(record => record.status === 'archived').length}`,
    `- Conflicted records: ${records.filter(record => record.status === 'conflicted').length}`,
    `- Review candidates: [${candidates.length}](review/candidates.md)`,
    `- Open conflicts: [${conflicts.length}](review/conflicts.md)`,
    `- Maintenance nominations: [${maintenance.nominations.length}](review/expiring.md)`,
    `- Freshness as of: ${formatTime(now)}`,
    '',
  ]
  appendRecordGroups(lines, 'By scope', records, record => `${record.scope.type}:${record.scope.key}`)
  appendRecordGroups(lines, 'By kind', records, record => record.kind)
  appendRecordGroups(lines, 'By status', records, record => record.status)
  appendRecordGroups(lines, 'By owner', records, record => record.owner)
  lines.push('## Freshness', '')
  const freshnessGroups = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    const key = freshnessLabel(record, now)
    const group = freshnessGroups.get(key) ?? []
    group.push(record)
    freshnessGroups.set(key, group)
  }
  for (const [label, group] of [...freshnessGroups].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${escapeInline(label)}`, '')
    appendRecordLinks(lines, group)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function appendRecordGroups(
  lines: string[],
  heading: string,
  records: readonly MemoryRecord[],
  keyOf: (record: MemoryRecord) => string,
): void {
  lines.push(`## ${heading}`, '')
  const grouped = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    const key = keyOf(record)
    const group = grouped.get(key) ?? []
    group.push(record)
    grouped.set(key, group)
  }
  for (const [key, group] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${escapeInline(key)}`, '')
    appendRecordLinks(lines, group)
    lines.push('')
  }
  if (grouped.size === 0) lines.push('No records.', '')
}

function appendRecordLinks(lines: string[], records: readonly MemoryRecord[]): void {
  for (const record of [...records].sort((left, right) => left.subject.localeCompare(right.subject) || left.memoryId.localeCompare(right.memoryId))) {
    lines.push(`- [${escapeInline(record.subject)}](records/${safeFileName(record.memoryId)}.md) · ${record.kind} · ${record.status} · r${record.revision}`)
  }
}

function freshnessLabel(record: MemoryRecord, now: number): string {
  if (record.expiresAt !== undefined) {
    if (record.expiresAt <= now) return 'expired'
    if (record.expiresAt <= now + 7 * 86_400_000) return 'expires-within-7-days'
  }
  const ageDays = Math.floor(Math.max(0, now - record.updatedAt) / 86_400_000)
  if (ageDays === 0) return 'updated-today'
  if (ageDays <= 30) return 'updated-within-30-days'
  return 'older-than-30-days'
}

function renderRecord(
  record: MemoryRecord,
  revisions: readonly MemoryRevision[],
  conflicts: readonly MemoryConflict[],
  now: number,
): string {
  const lines = [
    `# ${escapeInline(record.subject)}`,
    '',
    '> Generated by dsh-memory. Review decisions must use the service or an approved command.',
    '',
    '## Identity',
    '',
    `- ID: \`${escapeCode(record.memoryId)}\``,
    `- Revision: ${record.revision}`,
    `- Status: ${record.status}`,
    `- Kind: ${record.kind}`,
    `- Scope: ${escapeInline(record.scope.type)} · \`${escapeCode(record.scope.key)}\``,
    `- Sensitivity: ${record.sensitivity}`,
    `- Confidence: ${record.confidence.toFixed(2)}`,
    `- Owner: ${escapeInline(record.owner)}`,
    `- Created: ${formatTime(record.createdAt)}`,
    `- Updated: ${formatTime(record.updatedAt)}`,
    ...(record.expiresAt === undefined ? [] : [`- Expires: ${formatTime(record.expiresAt)}`]),
    `- Freshness: ${freshnessLabel(record, now)}`,
    '',
    '## When',
    '',
    htmlPre(record.applicability),
    '',
    '## What',
    '',
    htmlPre(record.action),
    '',
    '## Why',
    '',
    htmlPre(record.rationale),
    '',
    '## Evidence',
    '',
  ]
  if (record.evidence.length === 0) lines.push('- No evidence loaded.')
  else for (const evidence of record.evidence) {
    lines.push(`- **${evidence.kind}** · \`${escapeCode(evidence.locator)}\`${evidence.note === undefined ? '' : ` · ${escapeInline(evidence.note)}`}`)
  }
  lines.push('', '## Conflicts', '')
  if (conflicts.length === 0) lines.push('- None.')
  else for (const conflict of [...conflicts].sort((left, right) => left.id.localeCompare(right.id))) {
    const otherId = conflict.leftMemoryId === record.memoryId ? conflict.rightMemoryId : conflict.leftMemoryId
    lines.push(`- [${escapeCode(conflict.id)}](../review/conflicts.md) · ${conflict.status} · related memory \`${escapeCode(otherId)}\``)
  }
  lines.push('', '## Usage', '',
    `- Injected/read count: ${record.useCount}`,
    `- Helpful feedback: ${record.positiveFeedback}`,
    `- Negative feedback: ${record.negativeFeedback}`,
    ...(record.lastUsedAt === undefined ? [] : [`- Last used: ${formatTime(record.lastUsedAt)}`]),
    '', '## Revision history', '')
  for (const revision of revisions) {
    lines.push(`- r${revision.revision} · ${revision.operation} · ${formatTime(revision.createdAt)} · ${escapeInline(revision.actor.kind)}:${escapeInline(revision.actor.id)} · \`${revision.contentHash.slice(0, 12)}\``)
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function renderMaintenance(maintenance: MemoryMaintenanceResult): string {
  const lines = [
    '# Maintenance review queue',
    '',
    '> Generated by dsh-memory. Nominations never mutate records; use an approved review action.',
    '',
    `- Evaluated as of canonical activity: ${formatTime(maintenance.evaluatedAt)}`,
    `- Scanned active records: ${maintenance.scanned}`,
    `- Expired: ${maintenance.expiredCount}`,
    `- Expiring: ${maintenance.expiringCount}`,
    `- Negative feedback: ${maintenance.negativeFeedbackCount}`,
    `- Unused: ${maintenance.unusedCount}`,
    '',
  ]
  if (maintenance.nominations.length === 0) lines.push('No nominations.', '')
  for (const nomination of maintenance.nominations) {
    const record = nomination.record
    lines.push(
      `## [${escapeInline(record.subject)}](../records/${safeFileName(record.memoryId)}.md)`,
      '',
      `- Memory: \`${escapeCode(record.memoryId)}\` @ r${record.revision}`,
      `- Priority: ${nomination.priority}`,
      `- Reasons: ${nomination.reasons.join(', ')}`,
      `- Negative feedback ratio: ${nomination.negativeFeedbackRatio.toFixed(2)}`,
      ...(nomination.dueAt === undefined ? [] : [`- Due: ${formatTime(nomination.dueAt)}`]),
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function renderCandidates(candidates: readonly MemoryCandidate[]): string {
  const lines = [
    '# Candidate review queue',
    '',
    '> Generated by dsh-memory. Candidate text is untrusted and has not been published.',
    '',
  ]
  if (candidates.length === 0) lines.push('No pending candidates.', '')
  for (const candidate of candidates) {
    lines.push(
      `## ${escapeInline(candidate.content.subject)}`,
      '',
      `- Candidate: \`${escapeCode(candidate.id)}\``,
      `- Operation: ${candidate.operation}`,
      `- Status: ${candidate.status}`,
      `- Scope: ${escapeInline(candidate.content.scope.type)} · \`${escapeCode(candidate.content.scope.key)}\``,
      `- Kind: ${candidate.content.kind}`,
      `- Sensitivity: ${candidate.content.sensitivity}`,
      `- Confidence: ${candidate.content.confidence.toFixed(2)}`,
      `- Owner: ${escapeInline(candidate.content.owner)}`,
      `- Proposed by: ${escapeInline(candidate.actor.kind)}:${escapeInline(candidate.actor.id)}`,
      `- Proposed: ${formatTime(candidate.createdAt)}`,
      ...(candidate.targetMemoryId === undefined ? [] : [`- Target: \`${escapeCode(candidate.targetMemoryId)}\` @ r${candidate.expectedRevision}`]),
      ...(candidate.similarMemoryIds.length === 0 ? [] : [
        `- Similar published memories: ${candidate.similarMemoryIds.map(id => `[\`${escapeCode(id)}\`](../records/${safeFileName(id)}.md)`).join(', ')}`,
      ]),
      '',
      '**When**', '', htmlPre(candidate.content.applicability), '',
      '**What**', '', htmlPre(candidate.content.action), '',
      '**Why**', '', htmlPre(candidate.content.rationale), '',
      '**Evidence**', '',
    )
    for (const evidence of candidate.content.evidence) {
      lines.push(`- **${evidence.kind}** · \`${escapeCode(evidence.locator)}\`${evidence.note === undefined ? '' : ` · ${escapeInline(evidence.note)}`}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function renderConflicts(conflicts: readonly MemoryConflict[], records: readonly MemoryRecord[]): string {
  const byId = new Map(records.map(record => [record.memoryId, record]))
  const lines = [
    '# Open conflicts',
    '',
    '> Generated by dsh-memory. Both sides remain unavailable to normal retrieval until a reviewer resolves the conflict.',
    '',
  ]
  if (conflicts.length === 0) lines.push('No open conflicts.', '')
  for (const conflict of conflicts) {
    const left = byId.get(conflict.leftMemoryId)
    const right = byId.get(conflict.rightMemoryId)
    lines.push(
      `## Conflict \`${escapeCode(conflict.id)}\``,
      '',
      `- Created: ${formatTime(conflict.createdAt)}`,
      `- Left: [${escapeInline(left?.subject ?? conflict.leftMemoryId)}](../records/${safeFileName(conflict.leftMemoryId)}.md) @ r${conflict.leftRevision}`,
      `- Right: [${escapeInline(right?.subject ?? conflict.rightMemoryId)}](../records/${safeFileName(conflict.rightMemoryId)}.md) @ r${conflict.rightRevision}`,
      '',
    )
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function emptyPublication(mode: ProjectionPublication['mode']): ProjectionPublication {
  return Object.freeze({ mode, writtenFiles: 0, reusedFiles: 0, removedFiles: 0, totalFiles: 0 })
}

function removedProjectionContent(): string {
  return '# Removed knowledge projection\n\nThis generated page is no longer present in the canonical view.\n'
}

function atomicWriteIfChanged(path: string, content: string): boolean {
  const nextHash = contentHash(content)
  if (regularFileContentHash(path) === nextHash) return false
  atomicWrite(path, content)
  if (regularFileContentHash(path) !== nextHash) {
    throw new Error(`dsh-memory projection publication hash mismatch: ${path}`)
  }
  return true
}

function regularFileContentHash(path: string): string | undefined {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined
    return contentHash(readFileSync(path))
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }
}

function projectionBaseErrors(root: string, loaded: ReturnType<typeof readManifest>): string[] {
  const errors = [...validateProjectionLayout(root), ...loaded.errors]
  if (loaded.manifest === undefined) return errors
  if (loaded.manifest.generation !== generationHash(loaded.manifest.files)) {
    errors.push('manifest generation hash mismatch')
  }
  const managed = new Set(managedProjectionFiles(root))
  for (const relative of managed) {
    if (!(relative in loaded.manifest.files)) errors.push(`unexpected generated projection file: ${relative}`)
  }
  for (const relative of Object.keys(loaded.manifest.files)) {
    if (!managed.has(relative)) errors.push(`projection file missing: ${relative}`)
  }
  return errors
}

function verifyIncrementalPublication(
  root: string,
  expected: ProjectionManifest,
  checked: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): string[] {
  const loaded = readManifest(root)
  const errors = projectionBaseErrors(root, loaded)
  if (loaded.manifest?.generation !== expected.generation) {
    errors.push('published manifest generation mismatch')
  }
  for (const relative of checked) {
    const expectedHash = expected.files[relative]
    if (expectedHash === undefined) {
      errors.push(`published manifest entry missing: ${relative}`)
      continue
    }
    const path = join(root, relative)
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        errors.push(`projection entry is not a regular file: ${relative}`)
        continue
      }
      if (contentHash(readFileSync(path)) !== expectedHash) {
        errors.push(`projection content hash mismatch: ${relative}`)
      }
    } catch {
      errors.push(`projection file missing: ${relative}`)
    }
  }
  for (const relative of removed) {
    if (pathExists(join(root, relative))) errors.push(`removed projection file still exists: ${relative}`)
  }
  return errors
}

function atomicWrite(path: string, content: string): void {
  const parent = dirname(path)
  ensureDirectory(parent)
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  let fd: number | undefined
  let committed = false
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, content, { encoding: 'utf8' })
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    committed = true
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* preserve the publication error */ }
    }
    if (!committed) {
      try { unlinkSync(temporary) } catch { /* preserve the publication error */ }
    }
    throw error
  }
}

function validateProjectionLayout(root: string): string[] {
  const errors: string[] = []
  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch (error) {
    if (!isMissingFileError(error)) errors.push(`projection root is unreadable: ${root}`)
    return errors
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    errors.push('projection root is not a regular directory')
    return errors
  }
  for (const relative of ['records', 'review']) {
    const path = join(root, relative)
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        errors.push(`projection directory is not a regular directory: ${relative}`)
      }
    } catch (error) {
      if (!isMissingFileError(error)) errors.push(`projection directory is unreadable: ${relative}`)
    }
  }
  return errors
}

function createManifest(generated: ReadonlyMap<string, string>): ProjectionManifest {
  const files = Object.fromEntries(
    [...generated].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => [path, contentHash(content)]),
  )
  return createManifestFromHashes(files)
}

function createManifestFromHashes(input: Readonly<Record<string, string>>): ProjectionManifest {
  const files = Object.freeze(Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  ))
  return Object.freeze({
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    generation: generationHash(files),
    files,
  })
}

function generationHash(files: Readonly<Record<string, string>>): string {
  return contentHash(JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))))
}

function contentHash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function readManifest(root: string): {
  readonly files: readonly string[]
  readonly manifest?: ProjectionManifest
  readonly errors: readonly string[]
} {
  const path = join(root, MANIFEST)
  if (!existsSync(path)) return { files: [], errors: ['projection manifest missing'] }
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) return { files: [], errors: ['projection manifest is not a regular file'] }
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(value)) {
      if (value.some(item => typeof item !== 'string' || !isSafeRelative(item))) {
        return { files: [], errors: ['legacy projection manifest is invalid'] }
      }
      return { files: value, errors: ['legacy projection manifest has no content hashes'] }
    }
    if (!isProjectionManifest(value)) return { files: [], errors: ['projection manifest is invalid'] }
    return { files: Object.keys(value.files), manifest: value, errors: [] }
  } catch {
    return { files: [], errors: ['projection manifest is unreadable'] }
  }
}

function isProjectionManifest(value: unknown): value is ProjectionManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.format !== MANIFEST_FORMAT || candidate.version !== MANIFEST_VERSION) return false
  if (typeof candidate.generation !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.generation)) return false
  if (typeof candidate.files !== 'object' || candidate.files === null || Array.isArray(candidate.files)) return false
  return Object.entries(candidate.files).every(([relative, hash]) => isSafeRelative(relative) && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
}

function removeGeneratedFile(root: string, relative: string): void {
  if (!isSafeRelative(relative)) return
  const path = join(root, relative)
  try {
    const stat = lstatSync(path)
    // Unlinking a symlink removes the link itself and never follows its target.
    // This lets cleanup remove a stale managed link without touching a file
    // outside the projection root.
    if (stat.isSymbolicLink()) {
      unlinkSync(path)
      return
    }
    if (!stat.isFile()) {
      throw new Error(`dsh-memory projection cleanup refused non-file entry: ${relative}`)
    }
    unlinkSync(path)
  } catch (error) {
    if (isMissingFileError(error)) return
    throw error
  }
}

/** Enumerate only paths owned by the generated projection layout. */
function managedProjectionFiles(root: string): string[] {
  const files = new Set<string>()
  for (const relative of ['README.md', 'review/candidates.md', 'review/conflicts.md', 'review/expiring.md']) {
    if (pathExists(join(root, relative))) files.add(relative)
  }
  const recordsPath = join(root, 'records')
  try {
    const stat = lstatSync(recordsPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [...files]
    for (const entry of readdirSync(recordsPath, { withFileTypes: true })) {
      const relative = `records/${entry.name}`
      if ((entry.isFile() || entry.isSymbolicLink()) && isSafeRelative(relative)) files.add(relative)
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
  return [...files]
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isSafeRelative(value: string): boolean {
  return /^(?:README\.md|records\/[A-Za-z0-9._-]+\.md|review\/(?:candidates|conflicts|expiring)\.md)$/.test(value)
}

function ensureDirectory(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`dsh-memory projection path is not a regular directory: ${path}`)
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`dsh-memory projection path is not a regular directory: ${path}`)
    }
  }
  try {
    chmodSync(path, 0o700)
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}

function safeFileName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_')
  // Imported identifiers are not required to be UUIDs. Bound the path length
  // and retain a digest whenever normalization could collide.
  if (sanitized === value && value.length <= 120) return value
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12)
  return `${sanitized.slice(0, 100)}-${digest}`
}

function htmlPre(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeInline(value: string): string {
  return escapeHtml(value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#])/g, '\\$1'))
}

function escapeCode(value: string): string {
  // Backslashes do not escape delimiters inside Markdown code spans. Encode
  // them as entities instead; parsing sees no new delimiter, while readers
  // still get a faithful printable value.
  return value
    .replace(/&/g, '&amp;')
    .replace(/`/g, '&#96;')
    .replace(/[\r\n]+/g, ' ')
}

function formatTime(value: number): string {
  return new Date(value).toISOString()
}
