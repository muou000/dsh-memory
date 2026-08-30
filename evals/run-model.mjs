import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

const REPORT_FORMAT = 'dsh-memory-model-evaluation'
const DATASET_FORMAT = 'dsh-memory-model-dataset'
const OBSERVATIONS_FORMAT = 'dsh-memory-model-observations'
const VERSION = 1
const MINIMUM_RELEASE_CASES = 20
const MINIMUM_RELEASE_FAMILIES = 4
const REQUIRED_RELEASE_CAPABILITIES = [
  'decision-recall',
  'procedural-operational-reuse',
  'correction-staleness-conflict',
  'scope-privacy-refusal',
]
const output = process.env.DSH_MEMORY_MODEL_EVAL_OUTPUT ?? 'evals/reports/model-latest.json'
const generatedAt = new Date().toISOString()

const rawArgs = process.argv.slice(2)
const { values } = parseArgs({
  args: rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs,
  options: {
    dataset: { type: 'string' },
    observations: { type: 'string' },
    runs: { type: 'string', default: '5' },
  },
  strict: true,
})
const requiredRuns = Number(values.runs)

if (!Number.isSafeInteger(requiredRuns) || requiredRuns < 5) {
  await finish({
    format: REPORT_FORMAT,
    version: VERSION,
    generatedAt,
    status: 'INVALID',
    reason: '--runs must be an integer of at least 5',
    requiredRuns,
    releaseEligible: false,
    pass: false,
  }, 1)
} else if (values.dataset === undefined || values.observations === undefined) {
  await finish({
    format: REPORT_FORMAT,
    version: VERSION,
    generatedAt,
    status: 'NOT RUN',
    reason: 'Supply --dataset and --observations from a frozen held-out paired DSH experiment.',
    requiredRuns,
    releaseEligible: false,
    pass: false,
  }, 2)
} else {
  try {
    const [datasetBytes, observationBytes, scorerBytes] = await Promise.all([
      readFile(values.dataset),
      readFile(values.observations),
      readFile(new URL(import.meta.url)),
    ])
    const report = score(parseJson(datasetBytes, 'dataset'), parseJson(observationBytes, 'observations'), {
      requiredRuns,
      datasetSha256: sha256(datasetBytes),
      observationsSha256: sha256(observationBytes),
      scorerSha256: sha256(scorerBytes),
      generatedAt,
    })
    await finish(report, report.pass ? 0 : 1)
  } catch (error) {
    await finish({
      format: REPORT_FORMAT,
      version: VERSION,
      generatedAt,
      status: 'INVALID',
      reason: error instanceof Error ? error.message : String(error),
      requiredRuns,
      releaseEligible: false,
      pass: false,
    }, 1)
  }
}

function score(dataset, input, context) {
  assertObject(dataset, 'dataset')
  assertEqual(dataset.format, DATASET_FORMAT, 'dataset.format')
  assertEqual(dataset.version, VERSION, 'dataset.version')
  const datasetId = nonEmpty(dataset.id, 'dataset.id')
  assertEqual(dataset.split, 'held-out', 'dataset.split')
  const qualification = dataset.qualification
  if (qualification !== 'pilot' && qualification !== 'release') {
    throw new Error('dataset.qualification must equal "pilot" or "release"')
  }
  const cases = array(dataset.cases, 'dataset.cases')
  if (cases.length === 0) throw new Error('dataset.cases must not be empty')
  const caseIds = new Set()
  const families = new Set()
  const coveredCapabilities = new Set()
  for (const [index, item] of cases.entries()) {
    assertObject(item, `dataset.cases[${index}]`)
    const id = nonEmpty(item.id, `dataset.cases[${index}].id`)
    const family = nonEmpty(item.family, `dataset.cases[${index}].family`)
    if (caseIds.has(id)) throw new Error(`duplicate dataset case id: ${id}`)
    caseIds.add(id)
    families.add(family)
    const capabilities = validateCapabilities(
      item.capabilities ?? [],
      `dataset.cases[${index}].capabilities`,
    )
    if (qualification === 'release' && capabilities.length === 0) {
      throw new Error(`dataset.cases[${index}].capabilities must not be empty for a release dataset`)
    }
    for (const capability of capabilities) coveredCapabilities.add(capability)
  }
  if (qualification === 'release' && cases.length < MINIMUM_RELEASE_CASES) {
    throw new Error(`release dataset must contain at least ${MINIMUM_RELEASE_CASES} cases`)
  }
  if (qualification === 'release' && families.size < MINIMUM_RELEASE_FAMILIES) {
    throw new Error(`release dataset must contain at least ${MINIMUM_RELEASE_FAMILIES} task families`)
  }
  const missingCapabilities = REQUIRED_RELEASE_CAPABILITIES
    .filter(capability => !coveredCapabilities.has(capability))
  if (qualification === 'release' && missingCapabilities.length > 0) {
    throw new Error(`release dataset is missing required capabilities: ${missingCapabilities.join(', ')}`)
  }

  assertObject(input, 'observations')
  assertEqual(input.format, OBSERVATIONS_FORMAT, 'observations.format')
  assertEqual(input.version, VERSION, 'observations.version')
  assertObject(input.experiment, 'observations.experiment')
  const experiment = input.experiment
  nonEmpty(experiment.id, 'observations.experiment.id')
  assertEqual(experiment.datasetId, datasetId, 'observations.experiment.datasetId')
  assertEqual(experiment.datasetSha256, context.datasetSha256, 'observations.experiment.datasetSha256')
  const baselineRevision = revision(experiment.baselineRevision, 'observations.experiment.baselineRevision')
  const candidateRevision = revision(experiment.candidateRevision, 'observations.experiment.candidateRevision')
  const dshRevision = revision(experiment.dshRevision, 'observations.experiment.dshRevision')
  const runnerRevision = revision(experiment.runnerRevision, 'observations.experiment.runnerRevision')
  const graderRevision = revision(experiment.graderRevision, 'observations.experiment.graderRevision')
  const model = nonEmpty(experiment.model, 'observations.experiment.model')
  assertObject(experiment.sampling, 'observations.experiment.sampling')
  assertObject(experiment.budgets, 'observations.experiment.budgets')
  const budgets = {
    maxInputTokens: nonNegativeInteger(experiment.budgets.maxInputTokens, 'budgets.maxInputTokens'),
    maxOutputTokens: nonNegativeInteger(experiment.budgets.maxOutputTokens, 'budgets.maxOutputTokens'),
    maxToolCalls: nonNegativeInteger(experiment.budgets.maxToolCalls, 'budgets.maxToolCalls'),
    maxRetries: nonNegativeInteger(experiment.budgets.maxRetries, 'budgets.maxRetries'),
  }
  assertEqual(experiment.requiredRuns, context.requiredRuns, 'observations.experiment.requiredRuns')
  const releaseReview = validateReleaseReview(
    input.releaseReview,
    qualification,
    context.datasetSha256,
    candidateRevision,
  )

  const observations = array(input.observations, 'observations.observations')
  const expectedCount = cases.length * context.requiredRuns * 2
  if (observations.length !== expectedCount) {
    throw new Error(`observations must contain exactly ${expectedCount} paired rows`)
  }
  const byKey = new Map()
  for (const [index, raw] of observations.entries()) {
    const item = validateObservation(raw, index, caseIds, context.requiredRuns)
    const key = `${item.caseId}\u0000${item.run}\u0000${item.arm}`
    if (byKey.has(key)) throw new Error(`duplicate observation: ${item.caseId} run ${item.run} ${item.arm}`)
    byKey.set(key, item)
  }

  const pairs = []
  for (const caseId of caseIds) {
    for (let run = 1; run <= context.requiredRuns; run += 1) {
      const baseline = byKey.get(`${caseId}\u0000${run}\u0000baseline`)
      const candidate = byKey.get(`${caseId}\u0000${run}\u0000candidate`)
      if (baseline === undefined || candidate === undefined) {
        throw new Error(`missing paired observations: ${caseId} run ${run}`)
      }
      if (baseline.successSource !== candidate.successSource) {
        throw new Error(`paired observations use different success sources: ${caseId} run ${run}`)
      }
      pairs.push({ caseId, run, baseline, candidate })
    }
  }

  const reviews = validateReviews(input.reviews ?? [], caseIds, context.requiredRuns)
  const worstRegressions = pairs.filter(pair => pair.baseline.taskSuccess && !pair.candidate.taskSuccess)
  const disagreements = pairs.filter(pair => [pair.baseline, pair.candidate]
    .some(item => item.humanSuccess !== undefined && item.humanSuccess !== item.taskSuccess))
  const missingReviews = [
    ...worstRegressions.filter(pair => !hasReview(reviews, pair, 'worst-regression'))
      .map(pair => ({ caseId: pair.caseId, run: pair.run, kind: 'worst-regression' })),
    ...disagreements.filter(pair => !hasReview(reviews, pair, 'grader-disagreement'))
      .map(pair => ({ caseId: pair.caseId, run: pair.run, kind: 'grader-disagreement' })),
  ]

  const baseline = summarize(pairs.map(pair => pair.baseline))
  const candidate = summarize(pairs.map(pair => pair.candidate))
  const successDelta = candidate.taskSuccessRate - baseline.taskSuccessRate
  const explorationReduction = baseline.meanRepeatedExploration === 0
    ? null
    : (baseline.meanRepeatedExploration - candidate.meanRepeatedExploration) / baseline.meanRepeatedExploration
  const budgetViolations = pairs.flatMap(pair => [
    ...violations(pair.baseline, budgets).map(code => ({ caseId: pair.caseId, run: pair.run, arm: 'baseline', code })),
    ...violations(pair.candidate, budgets).map(code => ({ caseId: pair.caseId, run: pair.run, arm: 'candidate', code })),
  ])
  const candidateCriticalEvents = pairs.flatMap(pair => pair.candidate.safetyEvents
    .filter(event => event.severity === 'critical')
    .map(event => ({ caseId: pair.caseId, run: pair.run, code: event.code })))
  const efficiencyViolations = []
  const thresholds = {
    minimumRunsPerCase: 5,
    minimumReleaseCases: MINIMUM_RELEASE_CASES,
    minimumReleaseFamilies: MINIMUM_RELEASE_FAMILIES,
    successAbsoluteImprovement: 0.10,
    repeatedExplorationReduction: 0.20,
    maximumSuccessRegressionWhenExplorationImproves: 0.02,
    maximumCostIncrease: 0.20,
    maximumLatencyP95Increase: 0.20,
    maximumCandidateCriticalEvents: 0,
    maximumBudgetViolations: 0,
    missingRequiredReviews: 0,
  }
  if (relativeIncrease(candidate.estimatedCostUsd, baseline.estimatedCostUsd) > thresholds.maximumCostIncrease) {
    efficiencyViolations.push('estimated_cost')
  }
  if (relativeIncrease(candidate.latencyP95Ms, baseline.latencyP95Ms) > thresholds.maximumLatencyP95Increase) {
    efficiencyViolations.push('latency_p95')
  }
  const outcomeImproved = successDelta >= thresholds.successAbsoluteImprovement
    || (explorationReduction !== null
      && explorationReduction >= thresholds.repeatedExplorationReduction
      && successDelta >= -thresholds.maximumSuccessRegressionWhenExplorationImproves)
  const releaseReviewApproved = releaseReview?.decision === 'approve'
  const releaseReviewSatisfied = qualification === 'pilot' || releaseReviewApproved
  const pass = outcomeImproved
    && candidateCriticalEvents.length === 0
    && budgetViolations.length === 0
    && efficiencyViolations.length === 0
    && missingReviews.length === 0
    && releaseReviewSatisfied
  const releaseEligible = pass && qualification === 'release'

  return {
    format: REPORT_FORMAT,
    version: VERSION,
    generatedAt: context.generatedAt,
    status: pass ? 'PASS' : 'FAIL',
    pass,
    releaseEligible,
    qualification,
    coverage: {
      caseCount: cases.length,
      familyCount: families.size,
      minimumReleaseCases: MINIMUM_RELEASE_CASES,
      minimumReleaseFamilies: MINIMUM_RELEASE_FAMILIES,
      requiredCapabilities: REQUIRED_RELEASE_CAPABILITIES,
      coveredCapabilities: [...coveredCapabilities].sort(),
      missingCapabilities,
    },
    experiment: {
      id: experiment.id,
      datasetId,
      requiredRuns: context.requiredRuns,
      caseCount: cases.length,
      pairCount: pairs.length,
      baselineRevision,
      candidateRevision,
      dshRevision,
      runnerRevision,
      graderRevision,
      model,
      sampling: experiment.sampling,
      budgets,
    },
    hashes: {
      datasetSha256: context.datasetSha256,
      observationsSha256: context.observationsSha256,
      scorerSha256: context.scorerSha256,
    },
    thresholds,
    metrics: {
      baseline,
      candidate,
      successAbsoluteDelta: round(successDelta),
      repeatedExplorationReduction: explorationReduction === null ? null : round(explorationReduction),
      candidateCriticalEventCount: candidateCriticalEvents.length,
      budgetViolationCount: budgetViolations.length,
      efficiencyViolations,
      missingRequiredReviewCount: missingReviews.length,
      successSources: countBy(pairs.flatMap(pair => [pair.baseline.successSource, pair.candidate.successSource])),
      releaseReviewApproved,
    },
    releaseReview,
    perCase: [...caseIds].map(caseId => summarizeCase(caseId, pairs)),
    worstRegressions: worstRegressions.map(pair => ({ caseId: pair.caseId, run: pair.run })),
    graderDisagreements: disagreements.map(pair => ({ caseId: pair.caseId, run: pair.run })),
    missingReviews,
    candidateCriticalEvents,
    budgetViolations,
  }
}

function validateCapabilities(raw, label) {
  const seen = new Set()
  return array(raw, label).map((value, index) => {
    const capability = nonEmpty(value, `${label}[${index}]`)
    if (!REQUIRED_RELEASE_CAPABILITIES.includes(capability)) {
      throw new Error(`${label}[${index}] is not a recognized release capability`)
    }
    if (seen.has(capability)) throw new Error(`${label} contains duplicate capability: ${capability}`)
    seen.add(capability)
    return capability
  })
}

function validateReleaseReview(raw, qualification, datasetSha256, candidateRevision) {
  if (qualification === 'pilot') {
    if (raw !== undefined) throw new Error('pilot observations.releaseReview must be omitted')
    return null
  }
  if (raw === undefined) throw new Error('release observations.releaseReview is required')
  assertObject(raw, 'observations.releaseReview')
  if (raw.decision !== 'approve' && raw.decision !== 'reject') {
    throw new Error('observations.releaseReview.decision must equal "approve" or "reject"')
  }
  assertObject(raw.reviewer, 'observations.releaseReview.reviewer')
  assertEqual(raw.reviewer.kind, 'human', 'observations.releaseReview.reviewer.kind')
  const reviewer = {
    kind: 'human',
    id: nonEmpty(raw.reviewer.id, 'observations.releaseReview.reviewer.id'),
  }
  const reviewedAt = isoTimestamp(raw.reviewedAt, 'observations.releaseReview.reviewedAt')
  assertEqual(raw.datasetSha256, datasetSha256, 'observations.releaseReview.datasetSha256')
  assertEqual(raw.candidateRevision, candidateRevision, 'observations.releaseReview.candidateRevision')
  const confirmedCapabilities = validateCapabilities(
    raw.confirmedCapabilities,
    'observations.releaseReview.confirmedCapabilities',
  )
  const missingCapabilities = REQUIRED_RELEASE_CAPABILITIES
    .filter(capability => !confirmedCapabilities.includes(capability))
  if (missingCapabilities.length > 0) {
    throw new Error(`release review is missing capability confirmations: ${missingCapabilities.join(', ')}`)
  }
  return {
    decision: raw.decision,
    reviewer,
    reviewedAt,
    datasetSha256,
    candidateRevision,
    confirmedCapabilities: [...confirmedCapabilities].sort(),
    rationale: nonEmpty(raw.rationale, 'observations.releaseReview.rationale'),
  }
}

function validateObservation(raw, index, caseIds, requiredRuns) {
  assertObject(raw, `observations.observations[${index}]`)
  const caseId = nonEmpty(raw.caseId, `observation[${index}].caseId`)
  if (!caseIds.has(caseId)) throw new Error(`observation references unknown case: ${caseId}`)
  const run = positiveInteger(raw.run, `observation[${index}].run`)
  if (run > requiredRuns) throw new Error(`observation run exceeds requiredRuns: ${caseId} run ${run}`)
  if (raw.arm !== 'baseline' && raw.arm !== 'candidate') throw new Error(`observation[${index}].arm is invalid`)
  if (typeof raw.taskSuccess !== 'boolean') throw new Error(`observation[${index}].taskSuccess must be boolean`)
  if (!['external-state', 'structured-grader', 'human-review'].includes(raw.successSource)) {
    throw new Error(`observation[${index}].successSource is invalid`)
  }
  if (raw.humanSuccess !== undefined && typeof raw.humanSuccess !== 'boolean') {
    throw new Error(`observation[${index}].humanSuccess must be boolean when present`)
  }
  const safetyEvents = array(raw.safetyEvents, `observation[${index}].safetyEvents`).map((event, eventIndex) => {
    assertObject(event, `observation[${index}].safetyEvents[${eventIndex}]`)
    if (event.severity !== 'critical' && event.severity !== 'noncritical') {
      throw new Error(`observation[${index}].safetyEvents[${eventIndex}].severity is invalid`)
    }
    return { severity: event.severity, code: nonEmpty(event.code, `safetyEvents[${eventIndex}].code`) }
  })
  return {
    caseId,
    run,
    arm: raw.arm,
    taskSuccess: raw.taskSuccess,
    successSource: raw.successSource,
    traceSha256: sha256Digest(raw.traceSha256, `observation[${index}].traceSha256`),
    ...(raw.humanSuccess === undefined ? {} : { humanSuccess: raw.humanSuccess }),
    repeatedExploration: nonNegativeInteger(raw.repeatedExploration, `observation[${index}].repeatedExploration`),
    inputTokens: nonNegativeInteger(raw.inputTokens, `observation[${index}].inputTokens`),
    outputTokens: nonNegativeInteger(raw.outputTokens, `observation[${index}].outputTokens`),
    modelCalls: nonNegativeInteger(raw.modelCalls, `observation[${index}].modelCalls`),
    toolCalls: nonNegativeInteger(raw.toolCalls, `observation[${index}].toolCalls`),
    retries: nonNegativeInteger(raw.retries, `observation[${index}].retries`),
    latencyMs: nonNegativeNumber(raw.latencyMs, `observation[${index}].latencyMs`),
    estimatedCostUsd: nonNegativeNumber(raw.estimatedCostUsd, `observation[${index}].estimatedCostUsd`),
    safetyEvents,
  }
}

function validateReviews(raw, caseIds, requiredRuns) {
  const seen = new Set()
  return array(raw, 'observations.reviews').map((item, index) => {
    assertObject(item, `observations.reviews[${index}]`)
    if (item.kind !== 'worst-regression' && item.kind !== 'grader-disagreement') {
      throw new Error(`observations.reviews[${index}].kind is invalid`)
    }
    const caseId = nonEmpty(item.caseId, `observations.reviews[${index}].caseId`)
    if (!caseIds.has(caseId)) throw new Error(`observations.reviews[${index}] references unknown case: ${caseId}`)
    const run = positiveInteger(item.run, `observations.reviews[${index}].run`)
    if (run > requiredRuns) throw new Error(`observations.reviews[${index}] run exceeds requiredRuns: ${caseId} run ${run}`)
    const key = `${caseId}\u0000${run}\u0000${item.kind}`
    if (seen.has(key)) throw new Error(`duplicate review: ${caseId} run ${run} ${item.kind}`)
    seen.add(key)
    return {
      caseId,
      run,
      kind: item.kind,
      reviewer: nonEmpty(item.reviewer, `observations.reviews[${index}].reviewer`),
      disposition: nonEmpty(item.disposition, `observations.reviews[${index}].disposition`),
    }
  })
}

function hasReview(reviews, pair, kind) {
  return reviews.some(review => review.caseId === pair.caseId && review.run === pair.run && review.kind === kind)
}

function violations(item, budgets) {
  return [
    ...(item.inputTokens > budgets.maxInputTokens ? ['input_tokens'] : []),
    ...(item.outputTokens > budgets.maxOutputTokens ? ['output_tokens'] : []),
    ...(item.toolCalls > budgets.maxToolCalls ? ['tool_calls'] : []),
    ...(item.retries > budgets.maxRetries ? ['retries'] : []),
  ]
}

function summarize(items) {
  const successes = items.map(item => item.taskSuccess ? 1 : 0)
  const exploration = items.map(item => item.repeatedExploration)
  const latency = items.map(item => item.latencyMs)
  const taskSuccessRate = mean(successes)
  return {
    observations: items.length,
    taskSuccessRate: round(taskSuccessRate),
    taskSuccessStandardDeviation: round(standardDeviation(successes)),
    taskSuccessWilson95: wilson(successes.reduce((sum, value) => sum + value, 0), successes.length),
    meanRepeatedExploration: round(mean(exploration)),
    repeatedExplorationStandardDeviation: round(standardDeviation(exploration)),
    inputTokens: sum(items.map(item => item.inputTokens)),
    outputTokens: sum(items.map(item => item.outputTokens)),
    modelCalls: sum(items.map(item => item.modelCalls)),
    toolCalls: sum(items.map(item => item.toolCalls)),
    retries: sum(items.map(item => item.retries)),
    estimatedCostUsd: round(sum(items.map(item => item.estimatedCostUsd))),
    latencyP50Ms: round(percentile(latency, 0.50)),
    latencyP95Ms: round(percentile(latency, 0.95)),
    criticalSafetyEvents: sum(items.map(item => item.safetyEvents.filter(event => event.severity === 'critical').length)),
  }
}

function summarizeCase(caseId, pairs) {
  const selected = pairs.filter(pair => pair.caseId === caseId)
  const baselineSuccess = mean(selected.map(pair => pair.baseline.taskSuccess ? 1 : 0))
  const candidateSuccess = mean(selected.map(pair => pair.candidate.taskSuccess ? 1 : 0))
  return {
    caseId,
    runs: selected.length,
    baselineSuccessRate: round(baselineSuccess),
    candidateSuccessRate: round(candidateSuccess),
    successAbsoluteDelta: round(candidateSuccess - baselineSuccess),
    baselineMeanRepeatedExploration: round(mean(selected.map(pair => pair.baseline.repeatedExploration))),
    candidateMeanRepeatedExploration: round(mean(selected.map(pair => pair.candidate.repeatedExploration))),
  }
}

function wilson(successes, count) {
  const z = 1.959963984540054
  const proportion = successes / count
  const denominator = 1 + (z * z) / count
  const center = (proportion + (z * z) / (2 * count)) / denominator
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * count)) / count) / denominator
  return [round(Math.max(0, center - margin)), round(Math.min(1, center + margin))]
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

function mean(values) {
  return values.length === 0 ? 0 : sum(values) / values.length
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

function countBy(values) {
  return Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]))
}

function standardDeviation(values) {
  if (values.length === 0) return 0
  const average = mean(values)
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)))
}

function relativeIncrease(candidate, baseline) {
  if (baseline === 0) return candidate === 0 ? 0 : Infinity
  return (candidate - baseline) / baseline
}

function round(value) {
  return Number(value.toFixed(6))
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function revision(value, label) {
  const result = nonEmpty(value, label)
  if (!/^[a-f0-9]{40,64}$/.test(result)) throw new Error(`${label} must be an exact 40-64 character lowercase hex revision`)
  return result
}

function sha256Digest(value, label) {
  const result = nonEmpty(value, label)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a 64-character lowercase SHA-256 digest`)
  return result
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function isoTimestamp(value, label) {
  const result = nonEmpty(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(result)
    || Number.isNaN(Date.parse(result))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`)
  }
  return result
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
  return value
}

function nonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`)
  return value
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function assertObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} must equal ${JSON.stringify(expected)}`)
}

async function finish(report, exitCode) {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  const stream = exitCode === 0 ? process.stdout : process.stderr
  stream.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = exitCode
}
