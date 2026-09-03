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

This package ships five roles together because they share one public contract and persistence format:

- **Definition:** `ctx.memories` types and service operations.
- **Provider:** local transactional SQLite store and deterministic indexes.
- **Consumer:** scoped retrieval during `agent/pre-step` plus drill-down tools.
- **Consolidator:** optional bounded turn-end extraction into review candidates.
- **Human view:** generated Markdown index and record pages.

The contract admits a later remote provider or semantic candidate source without
changing consumer behavior. No semantic provider ships in `0.1.0`; deterministic
SQLite FTS is the fail-safe implementation. The package does not modify the DSH
agent loop.

## Sources and projections

```text
DSH session events / code / tests / human decisions
             |                         |
   optional bounded LLM extraction     |
             |                         |
             +------------+------------+
                          v
                    candidate record
                         |
        review / exact dedup / near-duplicate hint / conflict
                         |
                         v
 SQLite canonical record + immutable revisions + telemetry + audit
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

The provider combines exact match and SQLite FTS relevance, then applies
deterministic status, applicability, confidence, evidence, recency, and feedback
weights. Near-duplicate hints use deterministic token overlap inside the exact
scope and kind; they never merge records automatically.

The consumer retrieves only on the first step of a turn containing direct task
input. It calls `next()` first, preserves the downstream decision, and inserts a
separate plugin-sourced user message before the direct task. The rendering names
record ids and revisions, labels content untrusted, and obeys item and token
budgets. DSH records the admitted message, making replay exact.

Automatic injection and `memory_search` each allocate a stable retrieval id and
record candidate count, delivered ids/revisions/scores, token use, duration,
session, and turn where available. Zero-result retrievals are recorded too.
`memory_read` adds a content-free drill-down audit linked to that id, and
feedback can reference the same delivery. Tool search and detail results have separate hard token ceilings.

## Automatic consolidation

When explicitly enabled, the consolidator snapshots direct user text and assistant text at a normally completed `turn/end`. It excludes reasoning, tool results, plugin messages, incomplete turns, and sessions without an absolute workspace. The synchronous event callback only enqueues; bounded workers perform retrieval and model calls later.

Before model dispatch, the worker flushes the source session's standard events; it never adds repository-external event types to the DSH log. It then binds one prepared LLM call and writes append-only `memory_audit` reconstruction metadata: prompt version, source seqs, resolved route controls, input/system hashes, token cap, and allowed update target revisions. Same-workspace published records are the only valid update targets. Strict JSON output is converted to content only after local validation fixes scope, sensitivity, owner, evidence, expected revision, and idempotency key. Successful persistence adds a content-free completion audit naming candidate ids.

The auxiliary extraction model cannot call tools, publish, reject, contradict, widen scope, or edit canonical revisions. Exact duplicate handling and near-duplicate hints remain deterministic store policies. Optional AI review has three modes: `off`, `shadow` (record-only), and `enforce` (local-gated transitions). The reviewer receives no tools, must use a distinct resolved route, and its result is never sufficient alone: local checks revalidate exact request ownership, source/candidate hashes, workspace/sensitivity, duplicates, conflicts, expiry and target revision. Review result audit and any transition commit in one transaction; malformed, contradictory, low-confidence or stale results defer to human review. Session disposal cancels its work; plugin unload removes listeners, clears pending jobs, aborts active calls, and awaits plugin-owned workers before the store closes. Because DSH `session/flush` currently has no cancellation signal, abort stops waiting for a stuck provider but cannot cancel that provider's own operation; the provider retains responsibility for its teardown.

## Persistence and lifecycle

The local provider uses one SQLite database under
`<DSH_HOME>/memory/v1/memory.sqlite` unless an absolute configured path is
supplied. Schema v2 adds near-duplicate candidate metadata to the v1 canonical
schema through a forward-only transaction. WAL, foreign keys, busy timeout,
transactions, schema versioning, and
integrity checks protect canonical state. One process owns one writer handle;
additional instances fail or enter explicitly configured read-only mode.

Markdown pages are written through private temporary files and atomic rename.
A SHA-256 manifest is the generation commit marker. Full rebuilds read canonical
records and revisions in bounded batches and reuse byte-identical generated
files. After a verified generation is ready, known canonical mutations publish
the affected record pages plus deterministic global pages; an invalid manifest
or layout falls back to a full rebuild. Removed canonical pages are first
replaced with content-free tombstones, so a failed unlink cannot retain deleted
knowledge. The explicit verifier still re-hashes every managed file. The
provider owns the database through a Cordis effect; unload first drains lifecycle-owned automatic work, then removes listeners/tools/service and closes the writer handle.

Expiry, impending expiry, negative feedback, and inactivity produce a
deterministic human review queue; they do not mutate records. Reviewed candidate
content, raw opted-in query text, retrievals, feedback, and ordinary audit rows
have explicit retention windows. Pending candidates and canonical records are
never removed by retention. Physical purge requires logical deletion and keeps
only non-content proof.

## Failure semantics

- Missing store: initialize schema and empty projections.
- Invalid config: fail during plugin load.
- Unsupported newer schema or failed integrity check: fail closed with stage and
  path; never replace with a fresh store.
- Busy writer: bounded wait then actionable failure.
- Derived index/view damage: mark degraded and rebuild from canonical revisions;
  projection hashes expose partial publication or manual edits.
- Retrieval failure: log structured diagnostics and continue without injected
  knowledge only when canonical integrity remains known; never broaden scope.
- Proposal validation/redaction failure: reject with a reason code and store no candidate content.
- Consolidation model, framing, or output failure: store no candidate, emit a content-free classified log, and increment the process-local background failure counter.
- Consolidation queue overflow: drop the newer job, increment the failure counter, and never block `turn/end`.
- AI review source privacy, route, framing, output, or model failure: leave the already-created candidate pending, emit only bounded hashes/ids and a classified log, and increment the process-local background failure counter.
- AI review `shadow`: record the reviewer request/result audit but never transition a candidate. AI review `enforce`: publish/reject only when the deterministic local policy agrees; all other verdicts defer.
- Process crash before the consolidation request audit is flushed: no durable outbox exists in this version, so the turn is not automatically retried.

## Non-goals for the first stable release

- Training or modifying model weights.
- Automatically publishing model-generated rules.
- Treating vector similarity as authority or using one LLM prompt for extraction,
  review, deduplication, and merge.
- Replacing DSH session history, compaction, goals, skills, or authorization.
- A web administration application. Human browsing is Markdown; review uses the
  service/command boundary until a separately scoped UI consumer exists.
