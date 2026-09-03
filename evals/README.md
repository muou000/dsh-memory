# Evaluation entry points

`run-keyless.mjs` builds a synthetic, scope-separated fixture and computes a
development smoke score. Its `precisionAt6` value is the mean fraction of
returned hits containing the one expected fixture record (a returned-hit
precision, not conventional fixed-denominator Precision@6). It verifies the
scope boundary and deterministic ranking; it is not evidence of downstream
agent task success or a substitute for the held-out paired model evaluation.

`benchmark.mjs` constructs a 10,000-record reference store and measures warm
lexical search, budgeted rendering, first Markdown generation, content-addressed
warm rebuild, and one-record incremental publication. Set
`DSH_MEMORY_BENCHMARK_COUNT` only for a larger reference run.

`run-current-dsh-smoke.mjs --dsh-root <clean-checkout>` imports the neighboring
DSH build, composes the real public Agent, Tools, SystemPrompt, and Cordis
services with this plugin, exercises publication and incremental projection,
then verifies unload closes the store. It never writes to the DSH checkout.

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
`held-out` split and `qualification: pilot | release`, and contain unique
`{ id, family }` cases. A release-qualified dataset needs at least 20 cases and
four task families. Each release case also declares one or more controlled
`capabilities`; their union must include `decision-recall`,
`procedural-operational-reuse`, `correction-staleness-conflict`, and
`scope-privacy-refusal`. A statistically passing pilot remains
`releaseEligible: false`; only a passing release-qualified dataset with an
approved human release review can set it true. The observations file uses
format `dsh-memory-model-observations`, version 1. Its `experiment` pins the
dataset SHA-256, exact
baseline/candidate/DSH revisions, model, runner/grader revisions, sampling
parameters, shared token/tool/retry budgets, and repetition count.

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

Release observations also contain `releaseReview` with an `approve` or `reject`
decision, a human reviewer id, ISO-8601 review time, rationale, all four
confirmed capability labels, and the exact dataset SHA-256 and candidate
revision. Missing, stale, incomplete, or rejected review evidence cannot produce
`releaseEligible: true`.

AI review publication policy requires its own paired `off`/`shadow`/`enforce` evaluation before production enforcement. Freeze development, validation and held-out cases separately; include durable publishable cases, temporary state, near duplicates, stale updates, conflicts, scope violations, secret/private source, malformed reviewer output and prompt-injection attacks. Report publish precision, false publish/reject, defer rate, critical scope/privacy events, calls, tokens, cost and p95 latency. Any critical event, false publication above the preregistered threshold, or sustained cost/latency breach is a stop condition; switch back to `shadow` or `off` and retain the previous database backup. The deterministic mock tests prove policy wiring only, not reviewer semantic quality or provider independence.

Raw task inputs and model traces belong under ignored `evals/.runs/`; only a
reviewed, de-identified report should be committed. The scorer does not invoke
a model or infer success from agent prose. A keyless result cannot be reported
as evidence of downstream agent success. Write pilots to a distinct report by
setting `DSH_MEMORY_MODEL_EVAL_OUTPUT`, and leave `model-latest.json` fail-closed
until the release-qualified inputs exist.
