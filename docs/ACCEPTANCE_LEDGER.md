# Acceptance ledger

Candidate: not yet assigned  
DSH revision: `cd5ef8148158c3a752a658978873241fdf8e2bbc`  
Standard revision: 2026-08-29

This ledger starts fail-closed. Rows move to `PASS` only when the referenced
evidence exists and covers the complete gate.

| Gate | Status | Evidence |
| --- | --- | --- |
| Product outcome, real-model paired evaluation | NOT RUN | `evals/reports/` |
| Public capability seam and replayable DSH injection | PASS | `tests/loader-composition.spec.ts`; `pnpm run test:integration` |
| Versioned governance state machine | PASS | `tests/store-governance.spec.ts`; `tests/backup.spec.ts` |
| ACID persistence, migration, crash recovery | NOT RUN | Integration/fault tests |
| Scope isolation, privacy, prompt safety | PASS | `tests/scope-retrieval.spec.ts`; `tests/security.spec.ts` |
| Held-out retrieval quality thresholds | PASS | `evals/reports/keyless-latest.json` (Recall@6 1.00, Precision@6 0.806, MRR 1.00, cross-workspace 0) |
| 10k-record latency and rebuild | PASS | `evals/reports/benchmark-latest.json` (p95 31.476ms on Node v26.8.1) |
| Human-readable deterministic Markdown | NOT RUN | Golden/manual review |
| Observability, health, and lifecycle quiescence | NOT RUN | Integration tests |
| Backup, restore, migration, rollback runbooks | NOT RUN | Operator rehearsal |
| Windows and Unix-like supported matrix | NOT RUN | CI evidence |
| Packed-artifact clean install and dependency audit | NOT RUN | Release evidence |
| Shadow/canary observation | NOT RUN | Deployment report |
| Parent submodule pin and combined checks | NOT RUN | Parent check output |
