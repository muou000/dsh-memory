# Acceptance ledger

Runtime candidate revision: `89cfd4f4f6189f68427351e87cb892c8975f2de6`

Evaluation harness revision: `1513c2c938d491a1db7171715a21e5f6aafd945d`

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
| Real-model paired pilot (development evidence) | PASS | `evals/reports/model-pilot-latest.json`; one case, five pairs, baseline 0/5 versus candidate 5/5, cost proxy +3.8%, p95 latency +13.1%, `releaseEligible: false` |
| Public capability seam and replayable DSH injection | PASS | `tests/loader-composition.spec.ts`; clean `pnpm run test:integration` |
| Versioned governance state machine | PASS | `tests/store-governance.spec.ts`; `tests/operations.spec.ts` |
| ACID persistence, migration, crash recovery | PASS | `tests/backup.spec.ts`; `tests/writer-lock-subprocess.spec.ts`; `tests/operations.spec.ts` |
| Scope isolation, privacy, prompt safety | PASS | `tests/scope-retrieval.spec.ts`; `tests/security.spec.ts` |
| Keyless retrieval/isolation smoke | PASS | `evals/reports/keyless-latest.json`; 6 cases, recall 1.00, returned-hit precision 0.806, MRR 0.917, cross-workspace hits 0 |
| Held-out retrieval quality thresholds | NOT RUN | Keyless evaluation is a deterministic smoke score, not conventional held-out task evidence; frozen held-out set is still required |
| 10k-record latency and rebuild | PASS | `evals/reports/benchmark-latest.json`; 10,000 records, p95 74.183 ms <= 100 ms, 10,004 projections, byte/integrity validation true |
| Human-readable deterministic Markdown | NOT RUN | Automated golden/escaping/link/hash tests pass; representative human sign-off is pending |
| Observability, health, and lifecycle quiescence | PASS | `tests/observability.spec.ts`; clean Loader integration |
| Backup, restore, migration, rollback runbooks | PASS | `evals/reports/operator-rehearsal-latest.json`; 10/10 checks passed, including backup/export/import/restore/rollback |
| Exact-commit Windows/Ubuntu Node 22/24 CI matrix | NOT RUN | Local Windows checks and `evals/reports/unix-smoke-latest.json` (Ubuntu 24.04, Node 24.20.0) pass, but no successful four-leg workflow run is attached to the candidate |
| Packed-artifact clean install and dependency audit | PASS | `evals/reports/pack-smoke-latest.json`; clean tarball install, public import, CLI, and production audit all true |
| Shadow/canary observation | NOT RUN | No deployment observation supplied |
| Parent submodule pin and combined checks | PASS | Top-level gitlink points to this committed plugin evidence revision; `scripts/check-all.ps1` passed both plugins and `git submodule status --recursive` is clean |
