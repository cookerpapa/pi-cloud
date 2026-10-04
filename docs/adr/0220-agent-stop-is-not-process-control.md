# ADR-0220: Agent Stop is not VM process control

Status: accepted by the owner, 2026-10-04; implementation in progress.

## Correction

The chat Stop button means interrupt the current Agent Loop so the user can
continue the conversation. It does not mean kill a shell command or manage the
VM. This supersedes ADR-0219's Cube Stop/closure-acknowledgement contract and
ADR-0210's Run cancellation to process-stop coupling. Ordered publication,
destination position checks, boot fencing and physical absence requirements stay.

Reuse Pi's public Agent abort API and the existing abortable Worker reply mailbox.
No new cancellation transport, job scheduler, background-result store or process
manager is needed. PostgreSQL already persists the user cancellation request;
the Worker stops producing work at its source. Kafka continues to carry durable
Tool intents, native history, binding changes and final Run seals.

## Boundaries

- Stop aborts model streaming, prevents later model requests/Tool invocations and
  detaches the Worker from pending Tool replies. It does not wait for VM commands
  to finish. Native Tool results record that the Agent stopped waiting and that
  the external effect may still run; they must not claim the process was killed.
- An invocation already handed to publication can race Stop and can execute.
  Closing a binding rejects subsequent routing admission. It cannot recall a
  command already handed off to Cube. A missing handoff acknowledgement also
  never authorizes a compensating process kill or automatic replay.
- Already accepted commands run to completion or their existing explicit Tool
  timeout. The LLM can inspect and stop processes using a subsequent command.
  Chat Stop neither destroys the VM nor changes its normal Workspace lifecycle.
- Late replies cannot reopen a sealed Run or enter the next Run as its Tool
  result. The boot-scoped mailbox discards replies without an original waiter.
  Workspace files and process state remain inspectable in later Tools. Durable
  retrieval of arbitrary late output is not introduced by this correction.
- Binding closure is publication/routing admission metadata. PG plus its existing
  Outbox installs that revocation before the final seal. Remove stopped/quarantined
  lifecycle receipts, their polling and Cube Stop RPCs from Run settlement.
  Binding removal releases routing metadata, not VM capacity; physical VM deletion
  and quota release still require the existing independent lifecycle proof.
- Interactive workflow channels may close with their Agent caller. This stops
  orchestration and further agent calls; it does not kill accepted fixed Tools.
  Explicit VM shutdown and native Tool timeout remain separate operations.

## Delivery and verification

Update maintained documentation and cancellation assertions, rather than keeping
a compatibility path that stops processes. Remove obsolete closure-ACK columns
in a forward migration. Apply the matched runtime after draining active Runs;
do not reset user data or replay unknown commands.

Prove cancellation while streaming and while waiting for a published Tool,
including a stop racing the publication ACK, no subsequent model request, a
truthful native Tool result, discarded late replies and a usable next Run.
Prove PG revocation/release without Cube acknowledgement, no process-stop RPC on
ambiguous handoff, and shared-VM sibling isolation. A live command must survive
the chat Stop button and remain inspectable/controllable by the next Run.
