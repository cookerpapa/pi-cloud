# Pi Tool cancellation — 2026-10-04

## Result

Chat Stop now interrupts unfinished remote Tools through Pi's AbortSignal and
settles their original final replies. Bash cancels its current process group and
retains partial output. Completed background launches, independent setsid groups
and another Run sharing the VM survive. This implements
[ADR-0221](../adr/0221-pi-tool-cancellation.md), superseding ADR-0220's detach-only
behavior. Pending follow-up/steer and draft behavior remains unchanged and under
owner discussion.

The implementation is in `02280dc7`, with the trusted configuration forwarding
fix in `599906ec` and invocation acceptance fixture in `b92aa3ac`. The full check
exposed an omitted cancellation publisher in configuration normalization. The
port is now required, forwarded and covered through the actual remote adapter;
the affected workspace was rerun successfully before deployment.

## Data flow and failures

The existing PG cancellation request interrupts the Worker Agent. Its adapter
appends an operation-scoped cancellation through the same Session writer,
ingress and Kafka queue. Projector forwards it with the consumed position. Cube
delivers it to the original guest Tool, whose final reply returns through the
original Worker mailbox. Pi applies its hooks before canonical persistence and
Run sealing. A cancellation acceptance acknowledgement is not a Tool result.

Missing final replies become `tool_operation_outcome_unknown`; neither an
automatic Bash replay nor VM deletion follows. The default Tool-result grace is
10 seconds, while publication and sealing retain their own durability budgets.
An abnormal retirement keeps an immutable cancellation target in the existing
closed-binding control reference so it survives binding deletion. It selects only
unfinished operations of that Run/writer. There is no process-stop receipt table,
completed-result cache, new scheduler or per-Tool PG execution ledger.

## Verification

| Gate | Evidence |
| --- | --- |
| Workspace regression | 1,402 assertions in the 21 unaffected workspace runs and 254 in the corrected Supervisor rerun; nine external-service cases skipped by default |
| Types and acceptance helpers | All workspace types and 63 helper assertions passed |
| Deterministic faults | [166/166](pi-tool-cancellation-faults-20261004.md), clean source `599906ec`; these overlap workspace assertions |
| Real PostgreSQL + RF3 Kafka | Both ordered binding recovery and ordered cancellation/seal integration tests passed; Cube RPC is simulated in these two gates |
| Native Cube | 15 admission race tests passed, including 70,000 completions; the pinned full-module execution race test passed |
| Guest process semantics | Real process tests cover partial output, ordinary process-group cancellation, completed background survival and setsid survival |
| Static/deployment contracts | Documentation, runtime policy, build/patch identity and server-validated declarative Cube rendering passed |

The root `check` command initially failed on the configuration forwarding issue.
The verification above combines that run's passing workspaces with the corrected
workspace, type and helper reruns; it is not a claim that the initial command
exited successfully. Worker loss, lost publication acknowledgements, closed
bindings, late replies and delayed old submissions have automated coverage.
The new live fault test below covers Cube API unavailability, not Worker loss.

## Matched deployment and live acceptance

[Machine-readable release evidence](pi-tool-cancellation-rollout-20261004.json)
records app images `pi-cancel-v5-bridge`, native Cube/authorizer images
`pi-cancel-v5`, schema 172, managed protocol 5 and guest protocol 3. Cube patch
identity is `8b1acdced1b54c4f`, completion source
`f44aa025390e04b2cd9e76ff15af007624c6880f`, and guest source
`83cca93d753fa6b2a0c4482e8e51ecbe3a981fa9`.

Cutover verified no active Runs, leases, unsealed outputs, bindings or Cube VMs,
stopped Worker/Control Plane admission, checked again, and applied matched native
and platform Helm releases. No business-data reset was performed. Control Plane,
both Workers, Cube API and Cubelet are ready. All four new guest templates are
READY; 39 old-template cleanup timeouts remain deferred.

Two real GPT-6 Luna acceptance runs each used two Sessions sharing one Cube VM:

- Normal cancellation settled in **542 ms**. The active shell and ordinary child
  stopped, partial output and `Command aborted` reached history, and completed
  background/setsid processes survived. A subsequent Tool inspected and explicitly
  stopped those owned processes. The sibling completed; execution count was one.
- Cube API pause settled cancellation in **22,494 ms** with durable UNKNOWN
  context. No claim of foreground termination was made. After API restoration,
  the next Run verified background/setsid survival and cleaned up the fixture.
  The sibling completed and the original command was not replayed. The measured
  time includes Tool-result waiting and subsequent distributed Run settlement.

These exercise the chat Stop API path, not a new browser click test. Both fixtures
cleaned up their owned resources. Final inventory contains no active Runs,
leases, bindings or Cube VMs, and no missing image references. This is not an
exact attachment-inventory preservation test or proof of cross-boot process
recovery, exactly-once shell effects, fleet capacity or multi-node HA.
