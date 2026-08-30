# Acceptance ledger

Candidate: development candidate pending final clean release commit
DSH revision: `cd5ef8148158c3a752a658978873241fdf8e2bbc`  
Standard revision: 2026-08-29

This ledger starts fail-closed. Rows move to `PASS` only when the referenced
evidence exists and covers the complete gate.

| Gate | Status | Evidence |
| --- | --- | --- |
| Product outcome, real-model paired evaluation | NOT RUN | `evals/reports/` |
| Public capability seam and replayable DSH injection | PASS | `tests/loader-composition.spec.ts`; `pnpm run test:integration` |
| Versioned governance state machine | PASS | `tests/store-governance.spec.ts`; `tests/backup.spec.ts` |
| ACID persistence, migration, crash recovery | PASS | `tests/operations.spec.ts`; `tests/writer-lock-subprocess.spec.ts`; `tests/backup.spec.ts` |
| Scope isolation, privacy, prompt safety | PASS | `tests/scope-retrieval.spec.ts`; `tests/security.spec.ts` |
| Held-out retrieval quality thresholds | NOT RUN | The keyless report is a development smoke score; conventional held-out Recall@6/Precision@6/MRR requires paired dataset evidence. |
| 10k-record latency and rebuild | NOT RUN | Clean-candidate benchmark evidence is regenerated only after the release commit. |
| Human-readable deterministic Markdown | NOT RUN | Automated golden/escaping/link/hash tests pass; representative human sign-off pending |
| Observability, health, and lifecycle quiescence | PASS | `tests/observability.spec.ts`; `tests/loader-composition.spec.ts`; `pnpm run test:integration` |
| Backup, restore, migration, rollback runbooks | NOT RUN | The rehearsal script has 10 checks, but the current report was generated from a dirty tree; clean-candidate evidence is pending. |
| Windows and Unix-like supported matrix | NOT RUN | Windows checks will be attached to the clean candidate; the existing Unix report is from an earlier dirty tree. |
| Packed-artifact clean install and dependency audit | NOT RUN | Tarball smoke checks pass but current report is from a dirty development tree; clean release evidence pending |
| Shadow/canary observation | NOT RUN | Deployment report |
| Parent submodule pin and combined checks | PASS | Top-level `scripts/check-all.ps1`; initialized `git submodule status --recursive` |
