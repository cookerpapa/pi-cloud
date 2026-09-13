# ADR-0166 — Log-driven Subagent delegation

Status: accepted and implemented.

Supersedes ADR-0113's CLI-backed child adapter and Worker-local task mutations,
not the native Lane, execution authority, or Workspace contracts.

## Decision

Expose one role-free Subagent tool with direct delegation and scripted workflows.
Keep the community `runs.run` / `runs.all` programming model, not its local CLI,
file registry, persona catalog, or second SessionManager. A direct delegation
does not manufacture JavaScript or activate Cube. Model-generated workflow code
runs only inside Cube; it never runs in the trusted Worker or Projector.

Every child start, message, follow-up and cancellation is published by the
owning Worker under its existing execution publication to the same physical
Session Kafka partition. Program requests are control records, not synthetic
assistant Tool Calls. The Projector applies commands in log order and retains
idempotent command/dispatch state in PostgreSQL before advancing delivery.
Control handlers do not await a child model, a long Workspace fork, or a later
record's PG projection on the partition consumer stack.

The Worker owns the only active native Session writer. Child admission prepares
a durable Child Run, asks that Worker to create the named Lane, and makes the
Run runnable only after preparation. Lane creation still appends native records
through Kafka. Shared/isolated Workspace placement is independent from
fresh/branch context, and the branch anchor is frozen before dispatch. All
active Lanes remain on one Worker and use the existing PG Run queue and leases.

Use the Worker control transport for correlated progress/results. Persisted
command and Child Run state support reconnection; no 100ms result polling and
no second durable result log. A result is not delivered as successful before
its terminal projection. Receivers distinguish a notification, steering an
active operation, and scheduling follow-up work. An accepted message is not
yet a consumed model input. Repeated delivery must not duplicate Lane inputs.

Workflow guest IO uses Cube's existing envd process transport, not guest-held
database, Kafka, model, or Broker credentials. Calls travel through a bounded
request/response bridge back to the owning Worker writer. Script variables and
control flow are not checkpoints. The script's explicit return value is the
outer Tool result; the adapter must not replace it with concatenated child
transcripts. Tool progress and program calls are separate frame types.

Cancellation/ordered seals revoke new actions and cancel owned unfinished
children. Already-issued guest effects can remain UNKNOWN. Do not replay a
workflow or arbitrary shell work to recover JS memory. Reuse command identities
after lost acknowledgements, not new child executions. Never destroy a shared
development machine just to stop a workflow. Preserve bounded recursive capacity.

## Adopt before build

Reviewed Pi's official Subagent and SSH-operation examples, installed
`pi-subagents@0.50.0`, and upstream `0.67.0` at
`8e3f90f8f10194a5fea8de1135f4e56d67e574c5`. The latter's internal
`ChildSessionFactory` separates prompt/events/steer/abort from local SDK creation,
but its default file storage, ambient extensions and internal test injection
are not a supported native PostgreSQL Lane backend. Its ExternalJobProvider is
not the native child-session contract either. Reuse public Pi Agent/Tool/Session
contracts and the small community workflow API semantics; do not upgrade the
whole community runtime or import its trusted-process script evaluator.

References:

- [Pi Subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
- [Pi remote operations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/ssh.ts)
- [Community child runtime boundary](https://github.com/nicobailon/pi-subagents/blob/8e3f90f8f10194a5fea8de1135f4e56d67e574c5/src/runs/shared/child-session.ts)
- [Community workflow semantics](https://github.com/nicobailon/pi-subagents/blob/8e3f90f8f10194a5fea8de1135f4e56d67e574c5/docs/workflows.md)

## Acceptance

Verified duplicate start/lost notification, Lane readiness before claim,
cancellation during preparation, late invocation rejection, idempotent native
input consumption/cold restore, bounded transport and non-starving control scans.
Real DeepSeek/Cube acceptance covers eleven parent Turns and thirteen children:
pure research without Cube, parallel coding, shared/isolated Workspaces, recursive
delegation, in-flight steering, supervisor decisions and cancellation.

See [measured evidence](../reports/subagent-production-acceptance-latest.json)
and [release notes](../reports/log-driven-subagents-20260913.md). This remains a
foreground semantic-recovery contract, not a resumable workflow VM or multi-node
chaos benchmark.
