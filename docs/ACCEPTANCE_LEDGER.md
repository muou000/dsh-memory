# Acceptance ledger

Candidate code revision: `ac393a6eb28535e3a7cf0a2a1d390fbd08660f78`  
DSH revision: `cd5ef8148158c3a752a658978873241fdf8e2bbc`  
Standard revision: 2026-08-30

This ledger is fail-closed. A row is `PASS` only when its evidence is bound to
the candidate code revision above and the complete gate is covered. A passing
deterministic row does not substitute for the real-model, human, or rollout
gates marked `NOT RUN`.

| Gate | Status | Evidence |
| --- | --- | --- |
| Product outcome, real-model paired evaluation | NOT RUN | `evals/reports/model-latest.json`; no held-out deployment observations supplied |
| Public capability seam and replayable DSH injection | PASS | `tests/loader-composition.spec.ts`; clean `pnpm run test:integration` |
| Versioned governance state machine | PASS | `tests/store-governance.spec.ts`; `tests/operations.spec.ts` |
| ACID persistence, migration, crash recovery | PASS | `tests/backup.spec.ts`; `tests/writer-lock-subprocess.spec.ts`; `tests/operations.spec.ts` |
| Scope isolation, privacy, prompt safety | PASS | `tests/scope-retrieval.spec.ts`; `tests/security.spec.ts` |
| Held-out retrieval quality thresholds | NOT RUN | Keyless evaluation is a deterministic smoke score, not conventional held-out task evidence |
| 10k-record latency and rebuild | NOT RUN | Awaiting clean-candidate benchmark report |
| Human-readable deterministic Markdown | NOT RUN | Automated golden/escaping/link/hash tests pass; representative human sign-off is pending |
| Observability, health, and lifecycle quiescence | PASS | `tests/observability.spec.ts`; clean Loader integration |
| Backup, restore, migration, rollback runbooks | NOT RUN | Awaiting clean operator rehearsal report |
| Windows and Unix-like supported matrix | NOT RUN | Windows clean check is available; fresh Unix-like run is pending |
| Packed-artifact clean install and dependency audit | NOT RUN | Awaiting clean packed-artifact report |
| Shadow/canary observation | NOT RUN | No deployment observation supplied |
| Parent submodule pin and combined checks | NOT RUN | Top-level gitlink will be updated after plugin evidence is committed |
