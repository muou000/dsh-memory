import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const output = process.env.DSH_MEMORY_MODEL_EVAL_OUTPUT ?? 'evals/reports/model-latest.json'
const report = {
  format: 'dsh-memory-model-evaluation',
  version: 1,
  status: 'NOT RUN',
  reason: 'A deployment-specific DSH model route, held-out task set, and evaluator were not supplied.',
  requiredRuns: Number(process.argv[process.argv.indexOf('--runs') + 1] ?? 5),
  pass: false,
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.error(JSON.stringify(report, null, 2))
process.exitCode = 2
