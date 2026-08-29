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
```

`publish`, `reject`, `skip`, lifecycle transitions, and conflict resolution are
optimistic and append revisions. Model-facing tools cannot perform them. A
physical purge requires a prior logical `delete` and exact ID confirmation:

```powershell
dsh-memory purge <memory-id> --confirm <memory-id> --store C:\managed\memory.sqlite `
  --actor operator@example --reason "Approved privacy purge."
```

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
```

Portable JSON import validates format/version, content hashes, contiguous
revision chains, evidence, candidate references, and conflict references before
one ACID transaction. A failed import leaves the destination empty.

## Corruption and lock response

Startup runs SQLite `quick_check` and fails closed on corruption or an unknown
schema version. Do not delete the database to clear an error. Preserve the file
and writer-lock sidecar for incident evidence, copy it to isolated storage, and
restore the most recent validated backup to a new path. A stale lock is removed
only when its recorded PID is no longer alive and the file is not a symlink.

Projection failures do not roll back canonical writes. The service reports
`projectionState=degraded`, logs the stage and error without content, and a
subsequent `rebuild` regenerates all Markdown pages atomically.

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

## Release rehearsal

Run the following from a clean checkout before rollout:

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:integration
pnpm run eval:keyless
pnpm run eval:benchmark
pnpm run eval:model -- --runs 5
pnpm pack --dry-run
git diff --check
```

Record the exact plugin commit, DSH revision, keyless/benchmark reports,
unrun real-model evaluation, migration source and rollback target in the release
report. Observe a shadow or canary profile before broad enablement.
