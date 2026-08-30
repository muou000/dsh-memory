# Context-cost projection experiment - 2026-08-30

## Decision

The `40cfa48f3660b0656e59cb4d771fe45616549e0c` runtime candidate passes the
predeclared keyless projection and retrieval gates on the Windows reference
machine. It is suitable for development and canary evaluation, not production
promotion. No release-qualified real-model suite or exact-candidate Unix matrix
was run.

The neighboring DSH checkout was read-only and clean at
`cd5ef8148158c3a752a658978873241fdf8e2bbc` (`0.1.2-alpha.1`).

## Problem and hypothesis

The prior service regenerated every Markdown record after every proposal,
review, transition, feedback event, and purge. The prior 10,000-record report
measured one full projection at 51,368.761 ms. The hypothesis was that a
verified generation can reuse unchanged content hashes and publish known record
changes incrementally without weakening canonical SQLite, tombstone, manifest,
or explicit full-verification semantics.

Predeclared non-regression gates:

- 10,004 generated pages and a valid full SHA-256 verification;
- warm projection rebuild at or below 15,000 ms;
- one-record incremental publication at or below 5,000 ms;
- warm lexical retrieval/rendering p95 at or below 100 ms;
- one generated file written for the single-record mutation;
- unchanged scope-isolation and keyless retrieval scores.

## Candidate

- Batches canonical record, current/first/latest revision, parent revision, and
  evidence reads while retaining the same validation assertions.
- Reuses byte-identical generated files by SHA-256 during a full rebuild.
- Uses a bounded incremental publication after a verified generation exists;
  invalid layouts/manifests fall back to a full rebuild.
- Keeps the generation manifest as the final atomic commit marker and retains
  content-free tombstones before deletion.
- Adds content-free process-local counters for full rebuilds, incremental
  updates, files written, and failures.
- Removes `DISTINCT` from the FTS candidate count because startup integrity
  already verifies exactly one derived FTS row per active record.

## Results

The exact-candidate report `benchmark-latest.json` records:

| Metric | Prior report | Exact candidate | Gate |
| --- | ---: | ---: | ---: |
| First full generation | 51,368.761 ms | 51,838.563 ms | Informational |
| Content-addressed warm rebuild | Not measured | 10,436.633 ms | <= 15,000 ms |
| One-record incremental publication | Not available | 2,953.343 ms | <= 5,000 ms |
| Generated files written | 10,004 full build | 1 incremental | 1 |
| Retrieval p50 | 70.139 ms | 63.076 ms | Informational |
| Retrieval p95 | 74.183 ms | 77.800 ms | <= 100 ms |
| Projection files / valid | 10,004 / true | 10,004 / true | 10,004 / true |

Against the prior always-writing full rebuild measurement, the warm rebuild is
79.68% faster and the one-record path is 94.25% faster. First generation is
0.91% slower and remains an explicit large-store operational cost.

Intermediate runs were not discarded:

| Candidate stage | Warm rebuild | Incremental | Retrieval p95 | Outcome |
| --- | ---: | ---: | ---: | --- |
| Incremental writes, pre-batching | 19,137.468 ms | 7,587.231 ms | 105.257 ms | FAIL |
| Batched canonical reads | 17,706.811 ms | 5,844.016 ms | 91.167 ms | FAIL |
| Single-pass publication, dirty worktree | 9,509.468 ms | 2,661.712 ms | 80.113 ms | Projection gates pass; not exact |
| Exact `fbe8741` before FTS count optimization | 8,057.364 ms | 2,572.668 ms | 119.596 ms | FAIL |
| Exact `40cfa48` | 10,436.633 ms | 2,953.343 ms | 77.800 ms | PASS |

The exact failed run demonstrates latency variance; one passing run does not
establish a distribution. Canary monitoring must retain the 100 ms stop
condition and collect repeated machine-level samples.

## Additional evidence

- `pnpm run check`: 13 test files, 82 tests, typecheck and build pass.
- `pnpm run test:integration`: real Loader composition, 2 tests pass.
- `pnpm run eval:keyless`: recall 1.0, returned-hit precision 0.8056, MRR
  0.9167, cross-workspace hits 0.
- `pnpm run eval:current-dsh -- --dsh-root D:\deepseek-harness`: all six
  service/tool/publication/projection/unload checks pass against clean current
  DSH.
- `pnpm run eval:operations`: 10/10 backup/export/import/restore/rollback
  checks pass.
- `pnpm run eval:pack`: clean tarball install, public import, CLI, production
  audit pass; tarball SHA-256
  `abb783971103458bbd4098893bdb82b4c45080ae88039b8242a1dbca1419fb6a`.

Evidence hashes:

- benchmark report: `a155aca9f47822950d642af2219ded75cae38ad35db21a55f3c4cb17a6e071e3`
- current DSH smoke: `f791e461ef0f5a23a902a16a65cf49f02526dc18d07ba7360e3de756b4579d90`
- keyless report: `fcd8423b7e3b9b4a44b8ad15a906a7946a7003c03b075420f4538da44c059578`
- benchmark runner: `fbf7ea9822d4a81fe9a33c09418e7d108818e38c7d0fda0850bcc034f76b798a`

## Unrun and residual risk

- No real-model run was performed. The historical one-case pilot does not bind
  this candidate and is not release evidence.
- The exact-candidate Node 22/24 Windows/Ubuntu matrix and Unix smoke were not
  run.
- First generation still takes about 52 seconds for 10,000 records and needs a
  maintenance window.
- Incremental publication trusts unchanged content from the last verified
  generation; `projection-status` remains the full independent corruption
  scan. A changed managed layout or manifest forces a full rebuild.
- Retrieval p95 showed one 119.596 ms exact-run failure before the
  result-preserving count optimization. More repetitions are required before a
  production latency claim.

## Rollback

Disable automatic injection, retain the SQLite store and export, pin the prior
plugin revision `7e2d03f5ecced0c35580d8d7513c37d658385bd5`, then run `status`,
`rebuild`, and `projection-status`. The candidate adds no schema migration, so
canonical data remains backward compatible. Rollback discards only the derived
incremental publication behavior and its process-local counters.
