# dsh-memory

`dsh-memory` is a governed knowledge-memory plugin for DeepSeek Harness. It is
being built against the production gate in
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md); the current `0.1.0` line is a
development candidate and must not yet be represented as production accepted.

The design keeps one structured, versioned source for both consumers:

- AI agents receive a small, scope-filtered, source-attributed retrieval block
  recorded in the DSH session log and can drill into evidence through tools.
- People browse deterministic Markdown pages and review candidates, conflicts,
  freshness, ownership, evidence, and revision history.

Raw conversations are not copied into long-term memory. Model-generated content
enters a candidate queue and cannot publish itself.

## Status

The governed runtime, schema migration, model and administrative tools,
Markdown view, backup/restore, retention, metrics, and deterministic evaluation
entry points are implemented. Windows and Ubuntu keyless checks pass. Production
acceptance is still blocked on held-out real-model results, representative human
page review, and shadow/canary evidence; see
[`docs/ACCEPTANCE_LEDGER.md`](docs/ACCEPTANCE_LEDGER.md).

Supported target versions are Node.js `^22.19.0 || >=24`, pnpm 10, Cordis 4,
and the DSH `0.1.1-rc.2` public package surface. Exact validated revisions will
be recorded in the release report.

## Install

```powershell
dsh plugin --profile memory-dev add ./dsh-memory
dsh --profile memory-dev --dump-config
dsh-memory status --dsh-home "$env:DSH_HOME"
```

## Configuration

Use absolute paths for managed storage. This example keeps automatic recall
enabled, limits the model-visible block, and writes the human projection next
to the canonical database:

```yaml
- name: dsh-memory
  config:
    dshHome: 'C:/managed/dsh'
    autoInject: true
    maxInjectedItems: 6
    injectionTokenBudget: 1200
    markdownProjection: true
    secretPolicy: reject
    logQueryText: false
```

Verify both views after loading or restoring a profile:

```powershell
dsh --profile memory-dev --dump-config
dsh-memory status --dsh-home 'C:\managed\dsh'
dsh-memory projection-status --dsh-home 'C:\managed\dsh'
```

The generated `knowledge/` directory is read-only from an operator's point of
view; publish, correction, deletion, backup, and rollback go through the
service or the administrative CLI. The complete lifecycle and rollback steps
are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

The default canonical store lives under `<DSH_HOME>/memory/v1`; the sibling
`knowledge/README.md` is the human entry point. Use absolute configured paths
for managed or encrypted storage. Agents can search/read verified knowledge,
submit candidates, and attach feedback; only trusted operators can publish,
change lifecycle state, resolve conflicts, prune telemetry, or purge content.

Use `dsh-memory candidates`, `maintenance`, `metrics`, and `projection-status`
for routine review. Full configuration, backup, migration, rollback, retention,
and release procedures are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
