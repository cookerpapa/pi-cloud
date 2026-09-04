# ADR-0147: Self-contained append-only Pi Session event log

## Status

Accepted.

## Context

Pi 0.84.1 defines one monotonic sequence across immutable Entries, per-Lane
operation Records, Lane moves and Session facts. PiCloud previously persisted
that sequence in `pi_session_log`, but Entry and Record log rows contained only
an identifier whose payload lived in separate tables. The result was ordered,
yet the log alone was not a replayable Session fact stream.

Apache Maka demonstrates the useful invariant behind a log-first Agent
Runtime: committed semantic facts remain immutable, while model context, UI and
recovery state are projections. PiCloud needs the same invariant without
copying Maka's local single-host topology or permanently storing token-sized
presentation fragments in PostgreSQL.

PiCloud also has two independent delegated-context modes. A Child may branch
from a parent Entry or begin from an empty context and receive only its concrete
task. That choice must not decide how the Parent and Child communicate, where
their Workspace runs, or which Tools they receive.

## Decision

- `pi_session_log` is the canonical, self-contained semantic event stream for
  one physical Pi Session. Every row contains the complete Pi `LogItem`
  payload required to replay that mutation.
- The primary key `(tenant_id, session_id, seq)` is the Session-local commit
  order. All Lanes of one physical Session share it; different Sessions do not
  compete for a global sequence.
- `pi_session_entries`, `pi_session_records`, `pi_session_lanes` and
  `pi_session_labels` are transactional query projections. They may accelerate
  branch, open-operation, label and statistics reads, but they are not a
  competing conversation authority.
- A logical append and its affected projections commit in one PostgreSQL
  transaction. An acknowledged write therefore exposes neither a log-only nor
  a projection-only state.
- Human Forks keep independent Pi Sessions. Their canonical destination log
  contains complete copied Entry facts for the selected source branch; the
  existing copy-on-write Entry projection remains an implementation
  optimization and is not required to replay the destination log.
- Pi Compaction remains an immutable Entry in the same log. It changes the
  model-context projection, not canonical history, and is not a process-memory
  checkpoint.
- Assistant text deltas remain bounded Kafka AcceptedFacts. PostgreSQL receives
  the complete Assistant message, complete Tool facts and interruption
  settlement; it does not acquire a lifetime row per token fragment.
- Subagent `context=branch` creates a Lane at the declared parent Entry.
  `context=fresh` creates a Lane at `null` and appends only the concrete Child
  task. Both use the same Lane lifecycle, Run queue and ExecutionLease model.
- Parent/Child communication remains the orchestration-plane supervisor
  protocol keyed by Subagent execution identity. It neither depends on nor
  mutates Lane ancestry. Context, communication, Workspace placement and Tool
  policy are four independent choices.
- Old identifier-only `pi_session_log` rows are not supported. This development
  cutover resets existing conversation/Pi Session data instead of retaining a
  dual reader or migration fallback.

## Consequences

- One ordered log plus Pi's Session metadata is sufficient to reconstruct a
  complete multi-Lane conversation and its operation history.
- Query projections keep normal reads bounded without weakening the log-first
  authority model.
- Fork storage still benefits from copy-on-write reads, while its durable log
  no longer depends on the source Session payload surviving forever.
- A projection rebuild and Pi's upstream backend conformance suite become
  required acceptance checks.
- PostgreSQL write volume remains semantic rather than token-fragment-sized.
- This decision does not implement same-Run process resumption or memory
  restoration. Unknown Tool effects retain their existing conservative
  interruption semantics.
