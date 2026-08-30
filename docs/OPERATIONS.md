# dsh-memory operations

This plugin stores canonical knowledge in SQLite and generates a read-only
Markdown projection. The projection is disposable; never edit it as a source of
truth. Use the service API or the administrative CLI for decisions.

## Install and seed

```powershell
dsh plugin --profile memory-dev add ./dsh-memory
dsh --profile memory-dev --dump-config
dsh-memory status --dsh-home "$env:DSH_HOME"
```

The default database is `<DSH_HOME>/memory/v1/memory.sqlite`, and the human
view is its sibling `knowledge/` directory. Configure absolute managed paths
when the Harness home is ephemeral or encrypted storage is required.

## Review and lifecycle

```powershell
dsh-memory candidates --store C:\managed\memory.sqlite
dsh-memory publish <candidate-id> --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Evidence checked by owning team."
dsh-memory conflicts --store C:\managed\memory.sqlite
dsh-memory resolve <conflict-id> --action keep-left --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Left side is current and verified."
dsh-memory invalidate <memory-id> --revision 2 --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Source contract changed."
dsh-memory maintenance --store C:\managed\memory.sqlite
dsh-memory metrics --store C:\managed\memory.sqlite
```

`publish`, `reject`, `skip`, lifecycle transitions, and conflict resolution are
optimistic and append revisions. Model-facing tools cannot perform them. A
physical purge requires a prior logical `delete` and exact ID confirmation:

```powershell
dsh-memory purge <memory-id> --confirm <memory-id> --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Approved privacy purge."
```

Near-duplicate ids are review hints only. Compare applicability and evidence
before publishing, updating, skipping, or opening a contradiction. Run
`maintenance` on a schedule and make every lifecycle transition explicit; TTL,
feedback, and inactivity never auto-archive a record.

## Backup, restore, and import

Back up while the plugin is running. A backup is a SQLite snapshot created at a
new path and validated with `quick_check`; existing files are never overwritten.
Restore and import target a new or empty store. Stop writers before replacing a
deployment path, then run a status check before re-enabling the plugin.

```powershell
dsh-memory backup C:\backup\memory-2026-08-29.sqlite --store C:\managed\memory.sqlite
dsh-memory restore C:\backup\memory-2026-08-29.sqlite C:\managed\memory-restored.sqlite
dsh-memory export --store C:\managed\memory.sqlite > C:\backup\memory-export.json
dsh-memory import C:\backup\memory-export.json --store C:\managed\memory-empty.sqlite
dsh-memory rebuild --store C:\managed\memory-restored.sqlite
dsh-memory status --store C:\managed\memory-restored.sqlite
dsh-memory projection-status --store C:\managed\memory-restored.sqlite `
  --projection C:\managed\knowledge
```

Portable JSON import validates format/version, content hashes, contiguous
revision chains, evidence, candidate references, and conflict references before
one ACID transaction. A failed import leaves the destination empty.
Schema v1 SQLite backups are accepted and migrated to v2 on the first writable
open. Unknown newer versions fail before reads are served. Always restore to a
new path, verify `status`, `rebuild`, and `projection-status`, then switch the
deployment pointer; keep the old path as the rollback target.

## Corruption and lock response

Startup runs SQLite `quick_check` and fails closed on corruption or an unknown
schema version. Do not delete the database to clear an error. Preserve the file
and writer-lock sidecar for incident evidence, copy it to isolated storage, and
restore the most recent validated backup to a new path. A stale lock is removed
only when its recorded PID is no longer alive and the file is not a symlink.

Projection failures do not roll back canonical writes. The service reports
`projectionState=degraded`, logs the stage and error without content, and a
subsequent `rebuild` regenerates all Markdown pages. Each page is atomically
replaced and the generation manifest is committed last with SHA-256 hashes;
`projection-status` detects a partial generation, missing page, or manual edit.

## Rollback and uninstall

Disable automatic injection before changing the plugin version, retain the
SQLite file and export, install the prior pinned plugin commit, and run
`status` plus `rebuild`. To uninstall, disable the plugin first, export or back
up the database, then remove only the plugin package. Delete data separately
according to the workspace retention policy; physical purge is irreversible.

## Security and retention

Use owner-only permissions on the database and projection directory and rely on
disk encryption for at-rest protection. Secret-like values are rejected by
default; redaction is an explicit deployment choice. Queries are logged as
hashes unless `logQueryText` is deliberately enabled. Retrieval is scope,
sensitivity, status, expiry, and kind filtered before scoring. Review expired,
stale, negative-feedback, and open-conflict queues on a schedule appropriate to
the workspace; automatic promotion is not enabled.

Default operational retention is: reviewed candidate bodies 365 days, raw
opted-in query text 7 days, retrieval rows 180 days, feedback 365 days, and
ordinary audit 3650 days. A value of `0` means retain indefinitely for the
first four settings; purge, migration, and restore proofs are never removed by
ordinary audit retention. Apply policy explicitly:

```powershell
dsh-memory prune --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Quarterly approved retention run."
```

The CLI exposes `audit`, `retrievals`, and `feedback` for incident analysis.
`metrics` includes candidate outcomes, actual durably recorded injections,
review age, feedback, projection failures, process-local writer contention, and
the background-task failure counter (currently zero because no background tasks
are scheduled). These contain ids and bounded metadata, not model hidden
reasoning. `logQueryText` is off by default. Storage encryption and key rotation belong to the host disk
or managed volume; stop the writer, take a validated backup, rotate/remount,
then validate the new path before resuming.

## Configuration reference

| Setting | Default | Meaning |
| --- | ---: | --- |
| `autoInject` | `true` | Recall on the first model step of a turn. |
| `maxInjectedItems` / `injectionTokenBudget` | `6` / `1200` | Automatic and search-tool delivery limits. |
| `drillDownTokenBudget` | `4096` | Maximum estimated tokens returned by `memory_read`. |
| `retrievalCandidateLimit` / `minConfidence` | `24` / `0.6` | Lexical ranking pool and active-hit floor. |
| `nearDuplicateThreshold` | `0.65` | Same-scope/kind token-overlap hint threshold. |
| `maintenanceExpiringWithinHours` | `72` | Advance expiry review window. |
| `maintenanceNegativeFeedbackRatio` | `0.5` | Review ratio after at least 3 feedback events. |
| `maintenanceUnusedAfterDays` | `90` | Inactivity nomination threshold. |
| `secretPolicy` / `logQueryText` | `reject` / `false` | Admission and telemetry privacy defaults. |
| `busyTimeoutMs` / `integrityCheckOnStart` | `5000` / `true` | SQLite contention and startup validation. |

All paths must be absolute. Numeric limits are range-validated during plugin
load; unknown config keys fail early. See `src/config.ts` for the complete
retention and rendering bounds.

## Release rehearsal

Run the following from a clean checkout before rollout:

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:integration
pnpm run eval:keyless
pnpm run eval:benchmark
pnpm run eval:operations
pnpm run eval:pack
pnpm run eval:model -- --dataset <release-held-out.json> `
  --observations <release-paired-observations.json> --runs 5
git diff --check
```

Reject the release unless the model report contains `status: PASS`,
`releaseEligible: true`, all four required capability labels, and an approved
human `releaseReview` pinned to the dataset hash and candidate revision. A
`qualification: pilot` report remains development evidence even when every
pilot pair succeeds.

Run `evals/run-unix-smoke.sh` on one Unix-like host in addition to Windows.
Record the exact plugin and DSH revisions, dataset/scorer hashes, benchmark,
operator, package, and model reports, migration source, and rollback target.
The repository workflow additionally checks Node 22.19.0 and 24.20.0 on
Windows and Ubuntu; a release still requires a successful run attached to the
exact candidate commit.

For shadow rollout, keep injection disabled and compare scoped retrievals
against task traces without changing model input. For canary, enable one bounded
profile, monitor critical safety events, scope leakage, task success, no-hit
rate, p95 latency, projection failures, and writer contention. Stop on any
critical event, integrity error, unexplained success regression beyond 2 points,
or sustained latency/error breach; disable the plugin and restore the pinned
prior commit/path. Broad enablement requires the signed-off canary report.
