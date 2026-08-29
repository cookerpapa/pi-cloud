# 0133 — Versioned Agent identity and native Session Storage

## Status

Accepted.

## Context

PiCloud originally had one deployment-owned Agent, so a product Session could
implicitly mean “the current Pi coding Harness”. The database separately froze
the model used by each Turn, but it did not say which Runtime and Harness were
allowed to interpret the Session. That becomes unsafe when one platform or one
PostgreSQL cluster hosts several Agent products.

Mature Agent runtimes keep a stable application/assistant identity outside the
native thread state. Google ADK keys Sessions by application, user and Session;
LangGraph keys checkpoints by thread and checkpoint namespace and leaves their
serialization to the selected checkpointer. Neither requires unrelated
Runtimes to flatten their native state into one shared `messages[]` schema.

## Decision

PiCloud records a deployment-owned `AgentDefinition` and append-only
`AgentRevision`. A Session pins one Revision for its lifetime and every Run
copies that Revision as an immutable routing snapshot. Model selection remains
a separate Turn snapshot: the same Harness can use another allowed model
without changing its Session Storage protocol.

The first Revision is:

```text
definition:          pi-coding
runtime:             pi_sdk 0.84.1
harness:             pi-cloud-harness-v1
session storage:     pi_session_storage_v1
```

The Pi Worker queue joins the Run to its Revision and only claims `pi_sdk`
work. The Runner also rejects a command whose Runtime or Session Storage kind
is not the Pi contract it implements. A future Codex or Claude Worker therefore
cannot accidentally open a Pi Session merely because it can reach the same
PostgreSQL database.

Product metadata may share `sessions`, `turns` and `runs`. Native execution
state is shared only by Agent Revisions with the same Session Storage contract:

```text
Pi Agent Revisions       -> pi_session_* tables
another Runtime family  -> its own adapter and native tables/schema
```

Physically separate products may share one PostgreSQL cluster while owning
separate databases or schemas. A unified product may share the catalog tables,
but crossing Runtime families creates a new/forked native Session through an
explicit projection; it never reinterprets the old native rows in place.

## Consequences

- Session recovery and Worker routing have an explicit, versioned identity.
- Adding an Agent Runtime requires a current adapter, Worker capability and
  native Session Storage contract rather than a new string in the UI.
- Harness upgrades create a new Revision. Existing Sessions keep their pinned
  Revision until an explicit migration/fork policy is designed.
- This registry does not create a plugin marketplace or allow users to upload
  executable Harness code.

## Sources

- Google ADK `BaseSessionService`: application/user/Session scoped storage.
- LangGraph persistence: thread IDs, checkpoint namespaces and pluggable
  checkpointer/serializer protocols.
