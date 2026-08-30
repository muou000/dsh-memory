# Acceptance ledger

Runtime candidate revision: `40cfa48f3660b0656e59cb4d771fe45616549e0c`

Evaluation harness revision: `40cfa48f3660b0656e59cb4d771fe45616549e0c`

DSH revision: `cd5ef8148158c3a752a658978873241fdf8e2bbc`
Standard revision: 2026-08-30

This ledger is fail-closed. A row is `PASS` only when its evidence is bound to
the runtime candidate or the exact evaluation/package revision and hashes named
in its report, and the complete gate is covered. Evidence-only descendants must
not change runtime sources. A passing deterministic row does not substitute for
the real-model, human, CI-matrix, or rollout gates marked `NOT RUN`.

| Gate | Status | Evidence |
| --- | --- | --- |
| Product outcome, release-qualified real-model evaluation | NOT RUN | `evals/reports/model-latest.json`; no 20-case/four-family release dataset and observations supplied |
| Real-model paired pilot (development evidence) | NOT RUN | The historical one-case pilot does not bind the current runtime candidate; no current-candidate model observations were supplied |
| Public capability seam and replayable DSH injection | PASS | `tests/loader-composition.spec.ts`; clean `pnpm run test:integration`; `evals/reports/current-dsh-smoke-latest.json` passes six checks against clean DSH `0.1.2-alpha.1` |
| Versioned governance state machine | PASS | `tests/store-governance.spec.ts`; `tests/operations.spec.ts` |
| ACID persistence, migration, crash recovery | PASS | `tests/backup.spec.ts`; `tests/writer-lock-subprocess.spec.ts`; `tests/operations.spec.ts` |
| Scope isolation, privacy, prompt safety | PASS | `tests/scope-retrieval.spec.ts`; `tests/security.spec.ts` |
| Keyless retrieval/isolation smoke | PASS | `evals/reports/keyless-latest.json`; 6 cases, recall 1.00, returned-hit precision 0.806, MRR 0.917, cross-workspace hits 0 |
| Held-out retrieval quality thresholds | NOT RUN | Keyless evaluation is a deterministic smoke score, not conventional held-out task evidence; frozen held-out set is still required |
| 10k-record latency and rebuild | PASS | `evals/reports/benchmark-latest.json`; retrieval p95 77.800 ms <= 100 ms, warm rebuild 10,436.633 ms <= 15,000 ms, incremental update 2,953.343 ms <= 5,000 ms, 1 file written, 10,004 projections valid |
| Human-readable deterministic Markdown | NOT RUN | Automated golden/escaping/link/hash tests pass; representative human sign-off is pending |
| Observability, health, and lifecycle quiescence | PASS | `tests/observability.spec.ts`; incremental/full/files-written counters in `tests/projection.spec.ts`; clean Loader and current-DSH unload checks |
| Backup, restore, migration, rollback runbooks | PASS | `evals/reports/operator-rehearsal-latest.json`; 10/10 checks passed, including backup/export/import/restore/rollback |
| Exact-commit Windows/Ubuntu Node 22/24 CI matrix | NOT RUN | Local Windows Node 26 checks pass; the existing Unix report predates this candidate and no successful four-leg workflow run is attached |
| Packed-artifact clean install and dependency audit | PASS | `evals/reports/pack-smoke-latest.json`; clean tarball install, public import, CLI, and production audit all true |
| Shadow/canary observation | NOT RUN | No deployment observation supplied |
| Parent submodule pin and combined checks | NOT RUN | Pending the evidence-only report commit, parent gitlink update, and top-level `scripts/check-all.ps1` run |
