# Evaluation entry points

`run-keyless.mjs` builds a synthetic, scope-separated fixture and computes a
development smoke score. Its `precisionAt6` value is the mean fraction of
returned hits containing the one expected fixture record (a returned-hit
precision, not conventional fixed-denominator Precision@6). It verifies the
scope boundary and deterministic ranking; it is not evidence of downstream
agent task success or a substitute for the held-out paired model evaluation.

`benchmark.mjs` constructs a 10,000-record reference store and measures warm
lexical search plus budgeted rendering. Set `DSH_MEMORY_BENCHMARK_COUNT` only
for a larger reference run.

`operator-rehearsal.mjs` drives the built administrative CLI through candidate
inspection and approval, health checks, SQLite backup/restore, portable
export/import, rollback-target reads, and hashed Markdown projection checks in
an isolated temporary profile. Run it only after `pnpm run build`.

`run-unix-smoke.sh` creates a disposable Linux workspace, downloads the pinned
Node 24.20.0 build (override with `DSH_MEMORY_UNIX_NODE_VERSION` when a new
matrix entry is intentionally evaluated), verifies it against Node's published
SHA-256 list, installs the pinned pnpm release into that temporary directory,
performs a frozen clean install, and runs package, Loader, and keyless checks.
It does not install system packages. Pass the source root and optional report
path when the host shell is not already inside Linux; the report path is
resolved before the temporary workspace is entered.

`pack-smoke.mjs` runs the package lifecycle, installs the resulting tarball in
a fresh project with its declared peers, probes the public module and CLI, and
runs a production dependency audit against the official HTTPS registry. The
report binds the artifact SHA-256 to the source revision and marks whether the
source tree was clean; only a clean-tree run is release eligible.

`run-model.mjs` is a fail-closed scorer for deployment-produced, paired model
observations. Without both inputs it records `NOT RUN` and exits 2:

```powershell
pnpm run eval:model -- --dataset evals/.runs/held-out.json `
  --observations evals/.runs/paired-observations.json --runs 5
```

The dataset must use format `dsh-memory-model-dataset`, version 1, declare the
`held-out` split, and contain unique `{ id, family }` cases. The observations
file uses format `dsh-memory-model-observations`, version 1. Its `experiment`
pins the dataset SHA-256, exact baseline/candidate/DSH revisions, model,
runner/grader revisions, sampling parameters, shared token/tool/retry budgets,
and repetition count.

Each case/run needs exactly one `baseline` and one `candidate` row with task
success, repeated exploration, tokens, calls, retries, latency, cost, and
structured safety events. `reviews` must cover every baseline-success /
candidate-failure pair and every automated/human grader disagreement. The
scorer reports paired per-case differences, dispersion, Wilson intervals,
cost/latency, critical events, budget violations, and input/scorer hashes. It
fails a candidate whose estimated cost or p95 latency rises by more than 20%
from the paired baseline, even when the task outcome improves.
Each row also binds a raw trace SHA-256 and a success source. Accepted sources
are external-world state, a frozen structured grader, or human review; agent
self-report is not an accepted success signal, and paired arms must use the
same source.

Raw task inputs and model traces belong under ignored `evals/.runs/`; only a
reviewed, de-identified report should be committed. The scorer does not invoke
a model or infer success from agent prose. A keyless result cannot be reported
as evidence of downstream agent success.
