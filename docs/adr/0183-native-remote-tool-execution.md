# ADR 0183: whole-tool execution and native Pi replies

Status: implemented and validated, 2026-09-24.

## Decision

Run whole fixed read/write/edit/bash Tools in the credential-free Cube helper.
Reuse Pi's native edit/write implementations and output truncation primitives;
retain the cloud ranged-read and process-lifecycle adapters at that source.
Keep Agent Loop, validation/hooks, Session ownership and canonical Tool
Results in the trusted Worker. One invocation has one random operation ID;
internal filesystem calls are not separate distributed operations.

Carry Pi-native `tool_execution_update` and `tool_execution_end` payloads in a
small operation/routing envelope. Updates invoke the waiting Worker's native
`onUpdate`; completion resolves or rejects its `execute`. Worker Pi still owns
the actual lifecycle events, after-tool hooks and canonical result publication.
The guest executes no Agent Loop and holds no Kafka/model/database credential.

The trusted Cube adapter publishes bounded replies to a Worker-boot Kafka reply
topic. All slots share that topic. Replies are transport, not canonical Session
history. The reply channel must preserve per-operation order and reject updates
after completion/cancellation. It replaces completed raw-result caches and GET
retrieval; neither late replies nor another Worker resume an abandoned Tool.

Use explicit Kafka commit-before-dispatch for ordinary remote Tool commands.
Loss between commit and dispatch may omit execution and remains UNKNOWN. Text
projection replay can rewind; its dispatch watermark cannot rewind. Replayed
prefixes rebuild history/live state/seals without reissuing committed commands.
No automatic retry of ambiguous external effects, including after rebalance.
Existing executor authority and guest lifecycle checks remain. Kafka cannot
retract an already-issued Cube request or undo a shell side effect.

Capture/truncate output at source using Pi semantics; display truncation is not
an execution failure. Preserve bounded resource/cancellation handling and drain
output pipes. Do not create long-lived Tool artifacts or advertise missing full
output files. Whole-tool placement is our adapter, not a claim that upstream Pi
ships a Kafka remote executor.

## Scope and acceptance

Keep one execution-log Projector group, PG Session authority, leases/seals,
Subagent workflows, human terminals and Workspace lifetimes unchanged. Internal
file-management operations with actual callers are not legacy compatibility.

Require native-tool conformance, update/terminal ordering, source output bounds,
commit/replay/rebalance faults, multi-Worker reply routing, late-reply rejection,
and real Cube multi-round GPT-5.6 Luna coding. Do not use DeepSeek for paid tests.
Record latency excluding model time and clean only resources created by tests.

[Acceptance and remaining Cube template risk](../reports/native-remote-tools-acceptance-20260924.md).
