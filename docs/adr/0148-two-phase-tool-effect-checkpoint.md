# ADR-0148: Two-phase Tool effect checkpoint

## Status

Accepted.

## Context

A Pi sampling step may produce a complete Assistant message containing one or
more Tool calls. Before executing arbitrary shell or file effects, PiCloud must
know two different facts:

1. the complete model output is durable and recoverable;
2. one specific Tool call passed Pi validation and was admitted for execution.

Persisting the Assistant Entry, usage, public sampling boundary, public Tool
start and internal Tool intent as independent synchronous operations created
four or five serial barriers. Omitting Tool intent entirely would make every
Tool call in one Assistant message `UNKNOWN` after a crash, even when only the
first call could have started.

## Decision

- A Pi Session mutation may carry reviewed public events caused by the same
  semantic boundary. It remains one Authority-Gate decision and one
  Session-keyed Kafka AcceptedFact.
- At `message_end`, one atomic `append_items` mutation carries the complete
  Assistant Entry and its usage Record. The same Fact carries
  `model.sampling.completed` for the live Gateway projection.
- Pi performs its normal Tool name and parameter validation after that model
  checkpoint.
- The bound Tool wrapper then submits a second atomic mutation containing one
  `tool_started` Record. The same Fact carries public `tool.started`.
- The Tool implementation may run only after the second mutation has been
  projected to PostgreSQL and acknowledged to the Worker.
- Invalid Tool calls produce Pi's validation result without a `tool_started`
  Record.
- Tool intent uses `replay: never`. If the Worker disappears after intent but
  before a durable result, recovery records that Tool as `UNKNOWN`; calls
  without intent remain unstarted.
- The earlier argument-free `assistant.tool_call.preparing` event remains a
  live responsiveness hint while streamed Tool arguments are incomplete. It is
  not another post-sampling execution barrier.

## Consequences

- An arbitrary Tool effect has exactly two causally necessary post-sampling
  durability barriers.
- Assistant message plus usage and Tool intent plus Tool-start visibility are
  each internally atomic.
- Kafka redelivery keeps both checkpoints idempotent through their stable
  mutation IDs and the PostgreSQL Session log mutation index.
- A crash can distinguish the one Tool whose effect is uncertain from later
  Tool calls that never crossed the intent boundary.
- This is semantic recovery, not process-memory restoration or exactly-once
  shell execution. A Tool that crossed the intent boundary still requires
  state inspection after an ambiguous failure.
