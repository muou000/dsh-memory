# AGENTS.md

`dsh-memory` is an out-of-tree DeepSeek Harness (DSH) plugin that turns
evidence-backed project knowledge into a governed, replayable memory service.
It serves both model retrieval and human browsing without treating raw chat
history as durable knowledge.

## Required reading

Before changing runtime behavior, read the parent workspace `AGENTS.md`,
`docs/PLUGIN_STANDARD.md`, `docs/EVALUATION.md`, and the upstream DSH
`docs/architecture.md`. Read `docs/defensive-patterns.md` before changing
concurrency, persistence, background work, or teardown.

Treat `D:\deepseek-harness` as a read-only upstream reference unless the task
explicitly requests an upstream change. Import only public package exports.

## Product invariants

- The DSH session log remains the source of working-memory and model-visible
  history. This plugin stores curated long-lived knowledge and short-lived
  derived records, never hidden reasoning or an unfiltered transcript.
- Canonical knowledge is structured and versioned. Markdown is a deterministic
  human-readable projection, not an independent source of truth.
- Every record has evidence, scope, subject, timestamps, confidence, status,
  and revision lineage. Published content is never overwritten in place.
- Candidate creation is separate from publication. Model-facing tools may
  propose records but may not approve, publish, widen scope, or erase history.
- Retrieval filters authorization and scope before ranking. A global semantic
  match must never bypass workspace, session, agent, or user isolation.
- Conflicts stay explicit until a reviewer resolves them. Newer does not mean
  correct, and related does not mean mergeable.
- Model-visible retrieval is appended through a logged DSH input channel with
  record ids and revisions. It must be reconstructable after restart.
- Retrieved knowledge is untrusted data. Rendering must prevent it from
  impersonating system or developer instructions.
- Destructive removal requires an explicit actor and audit entry. Logical
  deletion precedes physical purge unless an approved privacy purge is used.
- All database handles, listeners, timers, tasks, and projections are owned by
  the plugin fiber and reach quiescence on unload.

## Development and acceptance

`docs/ACCEPTANCE.md` is the production gate. Do not weaken a threshold after
seeing a failing result and still call the same candidate accepted. Any change
to retrieval, injection, consolidation, expiry, or publication policy requires
paired baseline/candidate evidence under `evals/`.

Use ESM and strict TypeScript. Package-relative imports include `.ts`. Public
contracts and non-obvious failure semantics receive concise JSDoc. Validate all
database, JSON, tool, and model boundaries without introducing `any`.

Before committing run:

```powershell
pnpm run check
git diff --check
```

Run real-model evaluation only when the configured provider is available. A
green keyless suite does not prove end-to-end model benefit.
