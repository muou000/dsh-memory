# dsh-memory production acceptance standard

This document is the release gate for `dsh-memory`. Passing a subset creates a
development candidate, not a production release. Evidence must refer to the
exact plugin commit, DSH commit, configuration, dataset version, and runtime.

The three reference practices behind the gate are deliberately combined:

1. Experience is judged by downstream behavior, not by summary fluency.
2. A knowledge base is a governed supply system with admission, delivery,
   accounting, expiry, and revival, not a write-only vector store.
3. Evaluation, memory, rollout, and human control form one feedback loop;
   candidates never modify the stable system or its evaluator directly.

## 1. Product outcome

The plugin is accepted only when it demonstrably helps a DSH agent reuse
project-specific knowledge while keeping that knowledge maintainable by people.

Required outcomes:

- In the held-out long-horizon task suite, memory improves task success by at
  least 10 absolute percentage points **or** reduces repeated exploration by at
  least 20%, with task success no more than 2 points below the no-memory
  baseline.
- The comparison uses equal model, tool, retry, and token budgets. At least five
  repetitions per non-deterministic case are reported with dispersion.
- Every model dataset declares `qualification: pilot | release`. A release
  dataset contains at least 20 frozen cases across at least four task families;
  every case carries controlled capability labels and the suite covers decision
  recall, procedural or operational reuse, correction/staleness/conflict
  handling, and scope/privacy refusal. The paired observations include an
  explicit human release review pinned to the dataset hash and candidate
  revision. A pilot may pass its statistical thresholds but always reports
  `releaseEligible: false`.
- Candidate estimated cost and p95 latency may not increase by more than 20%
  against the paired baseline; the scorer reports these as explicit efficiency
  violations rather than hiding them behind a quality gain.
- No critical safety, privacy, cross-scope, irreversible mutation, or stale-rule
  failure is introduced. One such event rejects the candidate regardless of the
  aggregate score.
- The worst regressions and all disagreements between automated and human
  graders are reviewed and included in the release report.

Release-qualified real-model results are mandatory before a production tag.
Keyless replay and pilot results may qualify an implementation for development
or shadow deployment only.

## 2. Capability boundary and DSH integration

- The package exports stable named `name`, `Config`, and `apply` members and a
  documented `ctx.memories` service contract.
- Service definition, default provider, model-facing consumer, and human-facing
  projection are all present. Each can evolve without importing DSH private
  source paths.
- Working memory remains in the DSH session log. Episodic, semantic, and
  procedural knowledge are distinct record kinds; a temporary `working` record
  is session-scoped and must expire.
- Retrieval context added in `agent/pre-step` becomes a source-attributed
  `user/message`. Replaying the session against the same canonical store
  revision and configuration reproduces the exact record ids, revisions,
  content, order, and budget used by the original request.
- Waterfall listeners always delegate with `next()` and preserve downstream
  decisions, including `startsRequestSeries`.
- Loading, hot unloading, reloading, agent disposal, cancellation, and partial
  initialization leave no listener, database handle, timer, watcher, or task.

Evidence: public-API typecheck, real Loader test with `cordis.patch.yml`, session
replay snapshot, and resource-quiescence test.

## 3. Data model and governance

Every canonical record contains:

- stable id, kind, subject, structured `when`/`what`/`why`, scope, sensitivity,
  confidence, status, owner, creation/update/expiry timestamps;
- immutable revision number, parent revision, content hash, actor, operation,
  and at least one evidence reference for publishable knowledge;
- explicit candidate, active, conflicted, stale, archived, rejected, deleted,
  or purged lifecycle state as applicable.

Required behavior:

- Proposal and publication are separate transactions. Agent tools can only
  propose workspace- or narrower-scoped candidates.
- Exact duplicates are idempotent. Near duplicates are suggestions, not
  automatic merges. Different applicability conditions are never bridged into
  one record merely because their conclusions overlap.
- Updates use optimistic revision checks. A stale writer fails without changing
  the record.
- `create`, `update`, `skip`, and `contradict` decisions are recorded. Conflicts
  preserve both sides and require an explicit resolution actor.
- Invalidation, correction, archive, revival, logical deletion, and authorized
  physical purge are supported and audited.
- TTL, use decay, and negative feedback may nominate a record for review or
  archive; they do not silently rewrite or broaden it.

Evidence: state-machine, idempotency, optimistic-concurrency, conflict, expiry,
correction-propagation, delete, and purge tests.

## 4. Persistence, recovery, and portability

- The canonical store has an explicit schema version and forward migration
  path. An unknown newer version fails closed before serving reads.
- Each mutation is one ACID transaction. A crash cannot expose a new current
  revision without its revision body, evidence, and audit entry.
- Startup distinguishes absent, valid, locked, corrupt, and incompatible stores
  with actionable errors that name the plugin and stage without exposing data.
- The store enables integrity checks, bounded lock waiting, and durable journal
  settings. Two plugin instances cannot become concurrent writers to the same
  store silently.
- Backup/export and restore/import are documented and tested. Export is a
  versioned, deterministic, portable representation; restore validates before
  changing the live store.
- Files and directories use owner-only permissions where the platform supports
  them. Temporary publication files use private random names and atomic replace.
- A 10,000-record reference store passes integrity validation and can rebuild
  all derived indexes and Markdown views from canonical data.

Evidence: fault-injection subprocess tests, corruption/incompatibility tests,
backup/restore round trip, migration fixture, and rebuild test.

## 5. Scope, authorization, privacy, and prompt safety

- Scope filtering runs before scoring. The adversarial isolation suite permits
  zero records from another workspace, repository, session, agent, or user.
- Global publication, scope widening, approval, deletion, purge, and conflict
  resolution are unavailable to model-facing tools.
- Secret-like material, hidden reasoning, raw unrestricted tool output, and
  whole private transcripts are rejected or redacted before proposal storage.
- Query telemetry stores hashes and structural metrics by default, not complete
  user prompts. Full-content diagnostics require an explicit opt-in config.
- Every injected block labels knowledge as untrusted reference material,
  identifies scope and revision, and says it cannot override higher-priority
  instructions. Adversarial memory cannot change tool permissions or system
  policy in the prompt-injection suite.
- Export, deletion, expiry, and retention behavior is documented. Purge removes
  canonical content and derived views while retaining only the minimum
  non-content audit proof required by policy.

Evidence: isolation property tests, role/capability tests, secret fixtures,
prompt-injection replay, and deletion/export audit.

## 6. Retrieval quality and context budget

- Retrieval combines exact identifiers/terms, full-text relevance, structured
  scope/status filters, recency, confidence, evidence strength, and feedback.
  A semantic provider may contribute candidates, but its absence or failure has
  a deterministic lexical fallback.
- On the held-out retrieval set: conventional fixed-denominator `Recall@6 >=
  0.85`, `Precision@6 >= 0.70`, and
  `MRR >= 0.80`. Stale/conflicted/deleted records have zero active-hit rate
  unless explicitly requested by a reviewer.
- Ranking and budget selection are deterministic for identical store revision,
  query, access context, time input, and config.
- Injection never exceeds the configured item count or estimated token budget.
  It prefers applicability and action, with mechanism/evidence available through
  drill-down tools.
- At 10,000 active records on the reference machine, warm lexical retrieval and
  rendering have `p95 <= 100 ms`; injection adds no model call. The benchmark
  reports machine details rather than treating the threshold as universal.
- Recall, selection, actual injection, drill-down, positive/negative feedback,
  and downstream outcome can be joined by stable ids. Injection alone is not
  counted as adoption.

Evidence: frozen train/validation/test sets, deterministic scorer, token-budget
properties, benchmark report, and session-level accounting snapshot.

## 7. Human-readable knowledge base

- Every active or reviewable record has a deterministic UTF-8 Markdown page
  containing title, status, kind, scope, applicability, action, rationale,
  confidence, owner, revision, timestamps, evidence links, conflicts, and
  revision history.
- An index groups pages by scope, kind, status, owner, and freshness and links to
  review queues for candidates, conflicts, and expiring knowledge.
- Markdown is understandable without reading JSON or SQL and remains compact
  enough for Agent retrieval. The same canonical fields feed both human and AI
  views; there are not two divergent knowledge bases.
- Projections publish atomically, escape Markdown/front-matter control content,
  do not emit rejected secrets, and can be rebuilt byte-identically.
- The projection is visibly read-only/generated. Human decisions flow through
  review APIs or commands and then regenerate it; editing generated pages never
  mutates canonical data silently.

Evidence: golden rendering tests, escaping/adversarial fixtures, byte-identical
rebuild, link validation, and manual review of representative pages.

## 8. Observability and operations

- Structured logs identify plugin and stage and include record ids/revisions,
  counts, duration, and reason codes without content or credentials.
- Metrics cover proposal outcomes, review queue age, active/stale/conflict counts,
  retrieval latency, no-hit rate, selected/injected counts, budget use, feedback,
  projection failures, database contention, and background-task failures.
  `databaseContentionCount` is explicitly process-local (writer-lock collisions
  observed by this instance); `backgroundTaskFailures` is zero while the plugin
  has no background scheduler. Operators must aggregate per-process metrics and
  treat a future non-zero background counter as a release alarm.
- Health distinguishes ready, degraded-read-only, and unavailable states. A
  damaged index can rebuild; a damaged canonical store never falls back to an
  empty database silently.
- All configurable paths, thresholds, budgets, retention periods, review policy,
  and safety limits have validated defaults and documented units/ranges.
- Runbooks cover install, first seed, review, backup, restore, migration,
  corruption response, key rotation/external disk encryption responsibility,
  uninstall, data retention, rollback, and re-enable.

Evidence: log/metric assertions, degraded-mode tests, config matrix, and an
operator executing the runbook from a clean profile.

## 9. Test and release gates

The exact release commit must pass:

```powershell
pnpm run check
pnpm run test:integration
pnpm run eval:keyless
pnpm run eval:model -- --dataset evals/.runs/release-held-out.json `
  --observations evals/.runs/release-observations.json --runs 5
pnpm pack --dry-run
git diff --check
```

The model report must contain `status: PASS`, `releaseEligible: true`, all four
required capability labels, and an approved human `releaseReview`; a passing
pilot does not satisfy this command's release gate.

The parent workspace must then pin that committed plugin revision and pass:

```powershell
.\scripts\check-all.ps1
git submodule status --recursive
```

Additional mandatory evidence:

- Windows and one Unix-like Node runtime in the supported matrix;
- clean-install package smoke test using the packed artifact;
- no unresolved critical/high dependency vulnerability affecting runtime paths;
- signed-off release report with baseline/candidate hashes, unrun tests, known
  limits, migration and rollback instructions;
- shadow or canary observation before broad enablement. Automatic promotion is
  out of scope until a separate policy defines impact cap, stop conditions,
  approval, and rollback.

## 10. Acceptance ledger

`docs/ACCEPTANCE_LEDGER.md` maps every gate above to a test, report, or runbook.
An entry is `PASS`, `FAIL`, or `NOT RUN`; absence is `NOT RUN`. A production
claim requires every mandatory row to be `PASS`. Thresholds may be changed only
in a new, dated standard revision before evaluating the affected candidate.
