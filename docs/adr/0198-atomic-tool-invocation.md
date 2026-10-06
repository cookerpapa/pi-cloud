# ADR-0198: atomic remote Tool intent and dispatch


The single validated intent/dispatch boundary remains. Its former `tool_invocation` wire format is replaced by the native execute checkpoint plus compressed dispatch in [ADR-0229](0229-native-durable-runtime.md).
Status: implemented and validated, 2026-09-28.

[Implementation, fault and real Luna/Cube acceptance](../reports/tool-invocation-acceptance-20260928.md).

## Context and alternatives

ADR-0148 preserves complete model output before Pi validates individual Tool
calls. Its second checkpoint records one admitted invocation. Since ADR-0183,
fixed remote Tools then publish a separate Kafka command, adding a serial ACK
without adding an independent decision. The owner approved merging that intent
and command while retaining the earlier Assistant checkpoint.

Reuse the installed Pi 0.84.1 public Agent hooks and the existing pinned Kafka
producer/consumer adapters. Pi calls Tool `execute` after argument preparation,
validation and `beforeToolCall`; its earlier `tool_execution_start` notification
does not establish admission. No Agent-loop fork or duplicate validation is needed.

Kafka's [delivery semantics and transactions](https://kafka.apache.org/41/design/design/#message-delivery-semantics)
provide durable records and multi-record transactions. One existing Session-keyed
record suffices here: a Kafka transaction, PG Outbox or additional workflow engine
would add coordination for facts already known to the same writer. Keep the
adopted Kafka transport, RF3/acks-all and monotonic consumer dispatch commit.
This is a bounded application-envelope change, not a new log or effect ledger.

## Decision

- Complete Assistant output and usage still commit at `message_end` before Pi
  prepares individual calls. Rejected arguments/hooks never create Tool intent.
- Fixed `read/write/edit/bash` adapters expose a trusted preparation operation.
  It checks local limits, resolves the Cube binding and registers the boot-local
  reply callback, but neither publishes a command nor runs the guest Tool.
  Cube activation remains an infrastructure effect; preparation is not claimed
  to be free of all effects.
- The Runner commits one `tool_invocation` execution-log record containing the
  native `tool_started`, public start event and concrete dispatch descriptor.
  The existing physical-Session writer assigns all native stamps and waits for
  that one Kafka ACK. The descriptor reuses the intent's effective arguments,
  native Tool ID/name and result-Entry invocation identity rather than storing
  another argument copy. Scope and lease come from the enclosing publication.
- The same Projector validates scope/seals, materializes native intent and live
  state, then confirms its monotonic Kafka dispatch commit before forwarding a
  normal, fully expanded Tool command to Broker. Broker/guest protocols and
  independent authorization remain unchanged. History replay never reissues a
  command whose dispatch position was committed.
- Preparation/result callbacks are disposed on every exit. Cancellation before
  publication enters the log queue prevents the command; after submission it may
  race dispatch even before the producing Worker receives its ACK. Cancellation cannot retract an
  accepted log record. Existing Broker authority and guest cancellation apply.
- A failed/ambiguous publication poisons the shared native writer, without
  renumbering or re-publishing the invocation. Loss after dispatch commit but
  before actual dispatch remains UNKNOWN, without automatic Tool replay. Final
  replies still pass through Pi after-hooks before canonical result publication.
- Trusted platform/delegation Tools retain their own intent checkpoint. Their
  workflow scripts and child control commands are separate effects with actual
  callers; this slice does not fold an entire workflow into one Tool command.
  Fixed guest Tools no longer use the standalone command publication path.

## Cutover and acceptance

No PG schema, public API, Guest image or data authority changes. Use a matched,
quiescent Worker/Projector rollout. The distinct record kind makes old decoders
fail closed rather than silently ignore the dispatch descriptor. No fallback,
dual publication, legacy-producer mode or automatic effect retry is introduced.
Existing committed history remains readable. Rollback must drain/seal Runs and
finish projecting new records before restoring older binaries; export remains
the native Session log plus retained image objects.

Required checks: one combined publication after the Assistant ACK; invalid args,
blocked hooks, preparation failures, cancellation on each side of publication,
lost ACK and failed append; sequential/parallel calls and repeated provider IDs;
reply-before-ACK and cleanup; after-hook canonicalization; exact scope/intent/
command matching; bounded payloads; projection failure, replay, rebalance and
commit-before-dispatch faults. Run matched real GPT-6 Luna/Cube acceptance and
record evidence before marking the backlog complete.
