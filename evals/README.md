# Evaluation entry points

`run-keyless.mjs` builds a synthetic, scope-separated fixture and computes the
deterministic retrieval thresholds in `docs/ACCEPTANCE.md`.

`benchmark.mjs` constructs a 10,000-record reference store and measures warm
lexical search plus budgeted rendering. Set `DSH_MEMORY_BENCHMARK_COUNT` only
for a larger reference run.

`run-model.mjs` is deliberately fail-closed. It records `NOT RUN` and exits 2
until a deployment supplies a real DSH model route, held-out task set, paired
baseline/candidate protocol, and evaluator. A keyless result cannot be reported
as evidence of downstream agent success.
