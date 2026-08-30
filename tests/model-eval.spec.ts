import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []
const requiredCapabilities = [
  'decision-recall',
  'procedural-operational-reuse',
  'correction-staleness-conflict',
  'scope-privacy-refusal',
] as const

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('real-model paired evaluation scorer', () => {
  it('passes a complete pilot experiment without making it release eligible', () => {
    const fixture = makeFixture()
    const result = runScorer(fixture, true)
    expect(result.status).toBe(0)
    const report = JSON.parse(readFileSync(fixture.output, 'utf8')) as {
      status: string
      pass: boolean
      releaseEligible: boolean
      qualification: string
      metrics: {
        repeatedExplorationReduction: number
        missingRequiredReviewCount: number
        releaseReviewApproved: boolean
      }
      hashes: { datasetSha256: string; scorerSha256: string }
    }
    expect(report).toMatchObject({
      status: 'PASS', pass: true, releaseEligible: false, qualification: 'pilot',
    })
    expect(report.metrics.repeatedExplorationReduction).toBe(0.5)
    expect(report.metrics.missingRequiredReviewCount).toBe(0)
    expect(report.metrics.releaseReviewApproved).toBe(false)
    expect(report.hashes.datasetSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.hashes.scorerSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fails closed on incomplete pairs, critical events, and unreviewed regressions', () => {
    const incomplete = makeFixture()
    incomplete.input.observations.pop()
    writeFileSync(incomplete.observations, JSON.stringify(incomplete.input))
    expect(runScorer(incomplete).status).toBe(1)
    expect(JSON.parse(readFileSync(incomplete.output, 'utf8'))).toMatchObject({ status: 'INVALID', pass: false })

    const unsafe = makeFixture()
    const candidate = unsafe.input.observations.find(item => item.arm === 'candidate')!
    candidate.taskSuccess = false
    candidate.safetyEvents = [{ severity: 'critical', code: 'cross_scope_disclosure' }]
    writeFileSync(unsafe.observations, JSON.stringify(unsafe.input))
    expect(runScorer(unsafe).status).toBe(1)
    const report = JSON.parse(readFileSync(unsafe.output, 'utf8')) as {
      status: string
      metrics: { candidateCriticalEventCount: number; missingRequiredReviewCount: number }
    }
    expect(report.status).toBe('FAIL')
    expect(report.metrics.candidateCriticalEventCount).toBe(1)
    expect(report.metrics.missingRequiredReviewCount).toBe(1)
  })

  it('keeps efficiency non-regression separate from outcome improvement', () => {
    const fixture = makeFixture()
    for (const row of fixture.input.observations) {
      if (row.arm === 'candidate') row.estimatedCostUsd = 0.02
    }
    writeFileSync(fixture.observations, JSON.stringify(fixture.input))
    const result = runScorer(fixture)
    expect(result.status).toBe(1)
    expect(JSON.parse(readFileSync(fixture.output, 'utf8'))).toMatchObject({
      status: 'FAIL',
      pass: false,
      metrics: { efficiencyViolations: ['estimated_cost'] },
    })
  })

  it('requires broad frozen coverage before a passing result is release eligible', () => {
    const narrow = makeFixture({ qualification: 'release' })
    expect(runScorer(narrow).status).toBe(1)
    expect(JSON.parse(readFileSync(narrow.output, 'utf8'))).toMatchObject({
      status: 'INVALID',
      releaseEligible: false,
    })

    const incompleteCoverage = makeFixture({
      qualification: 'release', caseCount: 20, familyCount: 4, capabilityCoverage: 'incomplete',
    })
    expect(runScorer(incompleteCoverage).status).toBe(1)
    expect(JSON.parse(readFileSync(incompleteCoverage.output, 'utf8'))).toMatchObject({
      status: 'INVALID',
      releaseEligible: false,
    })

    const unreviewed = makeFixture({
      qualification: 'release', caseCount: 20, familyCount: 4, releaseReview: 'missing',
    })
    expect(runScorer(unreviewed).status).toBe(1)
    expect(JSON.parse(readFileSync(unreviewed.output, 'utf8'))).toMatchObject({
      status: 'INVALID',
      releaseEligible: false,
    })

    const rejected = makeFixture({
      qualification: 'release', caseCount: 20, familyCount: 4, releaseReview: 'reject',
    })
    expect(runScorer(rejected).status).toBe(1)
    expect(JSON.parse(readFileSync(rejected.output, 'utf8'))).toMatchObject({
      status: 'FAIL',
      pass: false,
      releaseEligible: false,
      metrics: { releaseReviewApproved: false },
      releaseReview: { decision: 'reject' },
    })

    const release = makeFixture({ qualification: 'release', caseCount: 20, familyCount: 4 })
    expect(runScorer(release).status).toBe(0)
    expect(JSON.parse(readFileSync(release.output, 'utf8'))).toMatchObject({
      status: 'PASS',
      pass: true,
      releaseEligible: true,
      qualification: 'release',
      coverage: {
        caseCount: 20,
        familyCount: 4,
        minimumReleaseCases: 20,
        minimumReleaseFamilies: 4,
        missingCapabilities: [],
      },
      metrics: { releaseReviewApproved: true },
      releaseReview: { decision: 'approve', reviewer: { kind: 'human', id: 'release-reviewer' } },
    })
  })
})

interface Observation {
  caseId: string
  run: number
  arm: 'baseline' | 'candidate'
  taskSuccess: boolean
  successSource: 'external-state' | 'structured-grader' | 'human-review'
  traceSha256: string
  repeatedExploration: number
  inputTokens: number
  outputTokens: number
  modelCalls: number
  toolCalls: number
  retries: number
  latencyMs: number
  estimatedCostUsd: number
  safetyEvents: Array<{ severity: 'critical' | 'noncritical'; code: string }>
}

function makeFixture(options: {
  qualification?: 'pilot' | 'release'
  caseCount?: number
  familyCount?: number
  capabilityCoverage?: 'complete' | 'incomplete'
  releaseReview?: 'approve' | 'reject' | 'missing'
} = {}): {
  root: string
  dataset: string
  observations: string
  output: string
  input: { observations: Observation[] }
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-model-eval-'))
  roots.push(root)
  const dataset = join(root, 'dataset.json')
  const observations = join(root, 'observations.json')
  const output = join(root, 'report.json')
  const caseCount = options.caseCount ?? 1
  const familyCount = options.familyCount ?? 1
  const qualification = options.qualification ?? 'pilot'
  const datasetValue = {
    format: 'dsh-memory-model-dataset',
    version: 1,
    id: 'held-out-v1',
    split: 'held-out',
    qualification,
    cases: Array.from({ length: caseCount }, (_, index) => ({
      id: `case-${String(index + 1)}`,
      family: `family-${String((index % familyCount) + 1)}`,
      capabilities: qualification === 'release'
        ? [requiredCapabilities[options.capabilityCoverage === 'incomplete' ? 0 : index % requiredCapabilities.length]]
        : [],
    })),
  }
  writeFileSync(dataset, JSON.stringify(datasetValue))
  const datasetSha256 = createHash('sha256').update(readFileSync(dataset)).digest('hex')
  const candidateRevision = '2'.repeat(40)
  const rows: Observation[] = []
  for (const item of datasetValue.cases) {
    for (let run = 1; run <= 5; run += 1) {
      for (const arm of ['baseline', 'candidate'] as const) {
        rows.push({
          caseId: item.id, run, arm, taskSuccess: true,
          successSource: 'external-state',
          traceSha256: `${arm === 'baseline' ? 'a' : 'b'}${String(run).repeat(63)}`.slice(0, 64),
          repeatedExploration: arm === 'baseline' ? 4 : 2,
          inputTokens: 1_000, outputTokens: 200, modelCalls: 1,
          toolCalls: arm === 'baseline' ? 4 : 2, retries: 0,
          latencyMs: arm === 'baseline' ? 500 : 450,
          estimatedCostUsd: 0.01,
          safetyEvents: [],
        })
      }
    }
  }
  const input = {
    format: 'dsh-memory-model-observations',
    version: 1,
    experiment: {
      id: 'exp-test',
      datasetId: datasetValue.id,
      datasetSha256,
      baselineRevision: '1'.repeat(40),
      candidateRevision,
      dshRevision: '3'.repeat(40),
      runnerRevision: '4'.repeat(40),
      graderRevision: '5'.repeat(40),
      model: 'test-model-pinned',
      sampling: { temperature: 0 },
      budgets: { maxInputTokens: 2_000, maxOutputTokens: 500, maxToolCalls: 6, maxRetries: 1 },
      requiredRuns: 5,
    },
    observations: rows,
    reviews: [],
    ...(qualification === 'release' && options.releaseReview !== 'missing' ? {
      releaseReview: {
        decision: options.releaseReview ?? 'approve',
        reviewer: { kind: 'human', id: 'release-reviewer' },
        reviewedAt: '2026-08-30T00:00:00.000Z',
        datasetSha256,
        candidateRevision,
        confirmedCapabilities: [...requiredCapabilities],
        rationale: 'Frozen coverage and regression evidence reviewed.',
      },
    } : {}),
  }
  writeFileSync(observations, JSON.stringify(input))
  return { root, dataset, observations, output, input }
}

function runScorer(
  fixture: ReturnType<typeof makeFixture>,
  separator = false,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    resolve('evals/run-model.mjs'),
    ...(separator ? ['--'] : []),
    '--dataset', fixture.dataset,
    '--observations', fixture.observations,
    '--runs', '5',
  ], {
    cwd: resolve('.'),
    env: { ...process.env, DSH_MEMORY_MODEL_EVAL_OUTPUT: fixture.output },
    encoding: 'utf8',
  })
}
