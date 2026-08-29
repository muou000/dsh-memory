# dsh-memory architecture

## Problem and hypothesis

DSH agents repeatedly rediscover project terminology, hidden code locations,
counter-intuitive constraints, and prior failure causes because useful evidence
is confined to one session or a person's memory. Saving complete transcripts or
embedding every message increases noise and can make later behavior worse.

The hypothesis is that a small set of evidence-backed, scope-constrained,
versioned knowledge records will improve later task success or reduce repeated
exploration when retrieval and injection stay within a strict context budget.
Quality, isolation, latency, and safety are non-regression metrics.

## Capability seam

This package initially ships four roles together because they share one public
contract and persistence format:

- **Definition:** `ctx.memories` types and service operations.
- **Provider:** local transactional SQLite store and deterministic indexes.
- **Consumer:** scoped retrieval during `agent/pre-step` plus drill-down tools.
- **Human view:** generated Markdown index and record pages.

The contract admits a later remote provider or semantic candidate source without
changing consumer behavior. The package does not modify the DSH agent loop.

## Sources and projections

```text
DSH session events / code / tests / human decisions
                         |
                         v
                   candidate record
                         |
             review / exact dedup / conflict
                         |
                         v
       SQLite canonical record + immutable revisions + audit
                 |                         |
                 v                         v
       lexical retrieval index      Markdown human view
                 |
                 v
        budgeted source-attributed DSH user/message
```

The session log is the source of what the model saw. SQLite is the source of
published long-lived knowledge. Full-text indexes and Markdown are disposable,
rebuildable projections.

## Record model

Kinds are `working`, `episodic`, `semantic`, and `procedural`. Working records
must be session-scoped and expiring; the normal working-memory path remains DSH
itself. Long-term retrieval normally uses the other three kinds.

A record separates:

- `when`: applicability conditions and boundaries;
- `what`: the fact, action, warning, or decision;
- `why`: mechanism, consequence, or rationale;
- evidence: stable references to sessions/events, files/commits, tests, URLs, or
  explicit reviewer statements.

The stable record id points to an immutable current revision. Updates create a
candidate whose expected parent revision must still be current at publication.
Conflicts are first-class links, never silent last-write-wins replacements.

## Scope and authority

Visibility is calculated before ranking. A query carries explicit global,
workspace, repository, session, agent, and user identities. A record is visible
only when its scope exactly matches one of those identities. Paths are
canonicalized at proposal and query boundaries.

Model tools can search, read visible records, propose workspace-or-narrower
candidates, and report feedback. They cannot publish, widen scope, resolve a
conflict, invalidate, delete, purge, migrate, back up, or restore. Those are
trusted service operations for human/admin consumers.

## Retrieval and injection

The default provider combines exact match and SQLite FTS relevance, then applies
deterministic status, applicability, confidence, evidence, recency, and feedback
weights. An optional semantic provider may add candidates, but a timeout or
failure cannot remove lexical results or change isolation.

The consumer retrieves only on the first step of a turn containing direct task
input. It calls `next()` first, preserves the downstream decision, and inserts a
separate plugin-sourced user message before the direct task. The rendering names
record ids and revisions, labels content untrusted, and obeys item and token
budgets. DSH records the admitted message, making replay exact.

## Persistence and lifecycle

The local provider uses one SQLite database under
`<DSH_HOME>/memory/v1/memory.sqlite` unless an absolute configured path is
supplied. WAL, foreign keys, busy timeout, transactions, schema versioning, and
integrity checks protect canonical state. One process owns one writer handle;
additional instances fail or enter explicitly configured read-only mode.

Markdown pages are written through private temporary files and atomic rename.
The provider owns the database and projection queue through a Cordis effect.
Unload closes admission, drains owned work, then closes the database.

## Failure semantics

- Missing store: initialize schema and empty projections.
- Invalid config: fail during plugin load.
- Unsupported newer schema or failed integrity check: fail closed with stage and
  path; never replace with a fresh store.
- Busy writer: bounded wait then actionable failure.
- Derived index/view damage: mark degraded and rebuild from canonical revisions.
- Retrieval failure: log structured diagnostics and continue without injected
  knowledge only when canonical integrity remains known; never broaden scope.
- Proposal validation/redaction failure: reject with a reason code and store no
  candidate content.

## Non-goals for the first stable release

- Training or modifying model weights.
- Automatically publishing model-generated rules.
- Treating vector similarity as authority or using one LLM prompt for extraction,
  review, deduplication, and merge.
- Replacing DSH session history, compaction, goals, skills, or authorization.
- A web administration application. Human browsing is Markdown; review uses the
  service/command boundary until a separately scoped UI consumer exists.
