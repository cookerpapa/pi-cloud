# ADR-0144: Subagents share one Pi Session tree through durable lanes

## Status

Accepted.

## Context

PiCloud originally represented every delegated Agent as a separate Pi Session.
A `context=fork` Child received one copy-on-write reference row for every Entry
on the inherited branch. Message payloads were not duplicated, but creating a
Child still performed work proportional to the inherited branch length and a
remote Worker had to resolve a second Session-shaped reference layer.

Pi's public SessionStorage already models an immutable Entry DAG with named
lane heads. Agent loops are independently schedulable, so sharing an Entry tree
must not imply sharing one Worker process, one in-memory Agent, one Run lease or
one Tool authority.

## Decision

Every product Session stores an explicit `(pi_session_id, pi_session_lane)`
binding. Human conversations continue to own their own Pi Session and `main`
lane. Every delegated Child remains a distinct product Session and Run, but it
receives a unique lane in the root conversation's Pi Session:

```text
Pi Session
├── main
├── subagent-<execution-id>
└── subagent-<execution-id>
```

`context=fork` creates the Child lane at the Entry immediately before the
parent prompt that requested delegation. `context=fresh` creates it at `null`.
Child Entries, operation records, interruption facts, World State and
Compaction are appended only to that lane. A Child's final result is returned
to the parent as the existing Subagent Tool result; other Child history is not
implicitly merged into the parent lane.

The logical product Session remains the Run, event, cancellation, UI and
ExecutionLease identity. The accepted Pi mutation protocol separately carries
the physical Pi Session target. The PostgreSQL Authority Gate resolves the
committed product Session binding and rejects a different Pi Session or lane
before Kafka accepts the mutation. Projectors do not recheck an expired lease
after durable acceptance.

Human “from this response” conversation forks remain separate Pi Sessions with
copy-on-write Entry references. They have independent user-controlled lifecycle
and are not delegated execution lanes.

## Consequences

- Delegated context forks create one lane row instead of one reference row per
  inherited Entry.
- Parent and Child can run concurrently on different Workers while PostgreSQL
  remains the shared Session authority.
- Pi Session sequence allocation is shared across lanes and briefly serializes
  commits on one PostgreSQL row. The bounded Subagent concurrency limit keeps
  this cost explicit and measurable.
- Worker runtimes, Compaction, recovery and World State must always use the
  command's immutable lane binding; `main` is not an implicit fallback.
- Archiving a Child hides its product Session but retains its lane and immutable
  Entries as audit/history state. Physical garbage collection requires a
  separate retention decision.
- Pi 0.84.1's high-level AgentHarness execution methods remain incomplete, so
  PiCloud keeps the public Agent Loop and makes its existing runtime lane-aware
  rather than patching Pi internals.
