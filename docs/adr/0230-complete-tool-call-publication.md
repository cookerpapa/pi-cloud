# ADR-0230: Publish Tool calls only after model response completion

Status: implemented, verified and deployed, 2026-10-06.

The owner requires incomplete model-generated Tool calls to remain in Worker
memory. Hiding argument deltas in the Web UI is insufficient: they must not
enter Kafka, PostgreSQL or native recovery history.

## Decision

Use the existing trusted Models adapter before Pi Durable consumes provider
events. Do not patch Pi, rewrite its Storage commits, or maintain another
execution checkpoint. Pi Durable 1.0.0 persists streamed assistant partials in
`pi.live`; its public Models boundary is the place to choose which partials it
receives. The accepted native writes remain losslessly stored under ADR-0229.

- Keep streaming local Tool call events and their arguments inside the model
  adapter. Publish only a payload-free `preparing_tool` observation through the
  existing lossy activity path.
- Forward text/thinking progress without Tool calls. Empty text slots preserve
  original content indexes where Tool blocks precede later text or thinking;
  no Tool name, ID or argument is stored in those slots. Detach the forwarded
  message so later provider mutations cannot insert a Tool into an earlier
  pending partial.
- Expose Tool calls when the complete successful assistant response arrives,
  retaining their complete arguments. This deliberately waits for the response
  boundary even if one call's `toolcall_end` arrived earlier. Pi then validates
  arguments, runs its Tool hooks and commits the execution intent. The existing
  intent/dispatch co-commit still precedes external execution.
- Error, abort, deferred and length-truncated responses do not retain local
  Tool calls. Their text, thinking, usage and status remain available; an
  incomplete call must not become a final history record through an error path.
- This policy concerns local `toolCall` blocks. Provider-hosted tools continue
  through the existing hosted-tool transcript boundary.

Stop or Worker loss before response completion leaves no new Tool intent or
partial argument history. Native model-request checkpoints still govern retry
and authorized recovery. Completed, validated Tool execution keeps Durable's
existing unsafe-interruption and cancellation rules. Historical commits are
immutable; the change governs newly admitted model output, not a history rewrite.

## Adopt-before-build evidence

Pi Durable's public model and event ports are sufficient. Its native
[`streamResponse`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/harness/generation.ts)
stores partial messages; there is no per-content-block persistence setting.
[`ToolTask`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/harness/tool.ts)
already validates final calls and commits intent before execution. Retain that
implementation and add a bounded stream policy at the existing Models port.
No queue, storage protocol, scheduler or new infrastructure is introduced.

## Acceptance

- Real native Harness commits contain no incomplete Tool blocks/arguments while
  a controlled provider is still streaming, including mixed text/Tool messages.
- Text keeps streaming with stable content indexes and detached snapshots;
  model activity reports preparing a Tool without its payload.
- Successful complete arguments survive unchanged; no Tool preparation or
  dispatch occurs before the original durable intent boundary.
- Error, cancellation, truncation and crash/reopen retain no incomplete calls;
  recovery preserves the original submission and does not invent a Tool result
  for a call that never became executable.
- Existing Tool cancellation, unsafe recovery, model grants and projection tests
  remain green. No dependency or public wire-schema change is required.

The native boundary tests are in
[`durable-tool-call-publication.test.ts`](../../packages/sandbox-supervisor/test/durable-tool-call-publication.test.ts).
They drive the public Models stream and the actual pinned Harness, inspect every
submitted storage batch, withhold intent acknowledgement, and reopen from a
committed pre-shutdown prefix. This is deterministic recovery evidence; it does
not claim that a MemoryStorage probe itself tests Kafka replication.

## Verification and deployment

- Sandbox Supervisor: 167 tests pass, including 10 new stream/native contract
  cases. Supervisor Host: 93 tests pass. Both affected workspaces typecheck;
  formatting, documentation and Worker image-closure checks pass.
- [Deterministic fault evaluation](../reports/tool-call-publication-faults-20261006.md):
  190/190 cases pass, including partial publication, provider mutation, Stop and
  reopen. The report captures the dirty `ea07e2cb` worktree; those runtime/test
  changes were committed as `af011ea4` before building the release image.
- Helm release `pi-cloud` revision 24 deploys
  `pi-cloud/supervisor-host:complete-tools-af011ea46133`. Both Worker Pods are
  updated and Ready. Runtime image inventory and private Helm values record the
  same desired image. This Worker-only release needs no schema or guest update.
- [Real GPT-6 Luna acceptance](../reports/complete-tool-call-live-20261006.json)
  executes `write` and `bash`, checks exact file bytes by SHA-256, and inspects
  the corresponding PG native log before deleting the disposable conversation.
  It observes 87 native writes, including 53 document writes with zero Tool-call
  objects, two complete Tool calls and two execute checkpoints. This live check
  exercises the actual Kafka/Projector/Cube path; interruption cases above use
  controlled model streams and native committed-prefix reopen.

Reproduce the live probe with
`PI_CLOUD_LIVE_COMPLETE_TOOL_CHECK=1 node --import tsx scripts/run-live-complete-tool-call-check.mjs`.
It uses Luna tokens and a disposable Workspace, then requests deletion of its
own conversation and Workspace. The report stores aggregate metadata only.
Historical records are not rewritten. Worker rollback uses the previous matched
image; it would restore the older partial-Tool publication policy.
