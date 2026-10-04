# Agent Stop correction — 2026-10-04

## Result

Chat Stop interrupts the Worker Agent Loop and pending Tool reply waits. It does
not kill VM processes. Accepted commands can continue; a subsequent Agent Tool
can inspect or terminate them. A Tool already handed to publication can race the
button and execute. Its uncertain outcome is not automatically replayed.

The correction follows the owner's clarified semantics in
[ADR-0220](../adr/0220-agent-stop-is-not-process-control.md). Code is in
`4b65b925`, the acceptance-discovered metadata fix in `eb82e01d`, and the current
fault manifest in `17bd65b7`.

## Removed coupling

- Run settlement no longer sends Cube Stop or waits for its process termination.
- Migration 171 removes binding closure receipt/revision columns and ACK polling.
  Routing revocation still precedes the final Session seal.
- Removed both the obsolete Worker-to-controller Stop envelope and Cube's native
  Stop RPC/protobuf/HTTP action. Managed transport is version 4; guest wire is 2.
- An ambiguous Tool handoff reports UNKNOWN without compensating process kills.
- Interrupted native Tool context says that the command may still be running.
  Late replies cannot satisfy another invocation or reopen a sealed Run.
- Explicit Tool timeout and physical VM lifecycle retain their existing behavior.
  Interactive workflow/input-preparation channels close with their Agent caller.

## Verification

| Gate | Evidence |
| --- | --- |
| PG routing/release, controller/client, remote Tools, schema | 124 assertions passed across 6 files |
| Pi/runtime, provider/client, binding view, mailbox, host, authorization | 211 assertions passed across 8 files |
| Authorization and release contract | 47 assertions passed across 2 files; overlaps the earlier authorization selection |
| Owner lookup retirement/readiness | 4 assertions passed across 2 files |
| Native Cube admission | 11 Go race tests passed, including 70,000 completions, delayed admission, timeout and sibling isolation |
| Real PG + RF3 Kafka | Both binding recovery and seal-without-Cube-Stop integration tests passed |
| Fault suite | [156/156](agent-stop-faults-20261004.md), clean source `17bd65b7` |
| Static/deployment contracts | Workspace types, documentation, runtime budgets, patch digest/build and server-validated Cube rendering passed |

The native Pi tests cover interruption while awaiting a reply and at the
publication ACK boundary, no later model request, durable uncertainty context and
a usable next Run. The original native Agent loop was not patched.

The RF3 recovery gate initially crashed with SIGSEGV. GDB located Confluent
1.10.1's nullable consumer-group description conversion. Ownership metadata now
uses the already-adopted Platformatic Admin on `ExecutionLogTopic`, through a
read port. Existing epoch checks/caching remain; there is no extra connection,
consumer group or parser patch. Both real integration gates passed afterward.

## Matched deployment and live acceptance

[Machine-readable evidence](agent-stop-rollout-20261004.json) records source
`17bd65b7`, app/Cube images `agent-stop-v4-meta`, schema 171, Cube patch
`c507fbd3bc6e15da`, completion source
`24039375d4353f13e8a575333ad0a117e8cea2fc` and guest source
`9cbc73ff371079762fca7da8fb77bf277a043118`. The authorizer uses `agent-stop-v4`;
its code is unchanged by the later metadata-only fix.

A drained cutover applied the rendered Cube release and the standard platform
Helm migration/deployment. The first platform preflight correctly refused a
not-yet-ready Cubelet; it passed once Cubelet startup completed. Control Plane
and both Workers are ready.

Three real GPT-6 Luna Runs used two Sessions sharing one Cube VM. The chat
cancellation API settled the first Run in **281 ms**. The next Run verified that
both its shell and child process survived, then explicitly terminated them with
Bash. The sibling's command completed, the first command executed once, and the
interrupted Tool context was retained. The fixture deleted its owned resources;
final inventory had no active Runs, leases, bindings or Cube VMs.

This is API-driven button-path acceptance, not a new browser interaction test.
The existing orphan-image reaper stayed enabled: raw image-object inventory was
24 before cutover and 21 after acceptance, with zero missing image references.
This run does not claim an exact unchanged attachment inventory. The migration
only removes binding receipt columns; image cleanup policy is unchanged.
The previously recorded 35 old-template cleanup timeouts remain deferred; all
four new templates are READY. No claim of cross-boot process/result recovery or
exactly-once shell effects is added.
