# ADR-0277: Model-event waiting and conversation commands

Status: implemented and deployed, 2026-10-26, as `commands-514e2b0f` (schema 199).
See [delivery evidence](../reports/conversation-commands-delivery-20261026.md).
The owner approved the
[revised plan](../reports/slash-commands-plan-20261025.md), then confirmed that a
Run represents user-requested cloud work, including a cold manual compaction.

## Model requests

Keep one native retry authority. Pi Durable uses five retries; provider/SDK
sampling retries remain disabled. The trusted Models adapter owns a 300-second
valid-provider-event inactivity timer, including initial response waiting after
model-permit admission. Valid non-text events renew it; transport comments and
arbitrary bytes do not. Stop and ownership loss remain cancellation. Inactivity
expires as a retryable error, not a user abort, and late completion cannot win.

The Worker Model Gateway retains only actual connection establishment timeout
(15 seconds by default), HTTP admission and transport cancellation. Remove its
header/byte-idle timers and the competing Pi response-header budget. The fixed
SDK receives no extra retries. Codex SSE's header timer is disabled; the OpenAI
Responses SDK's unavoidable header-only timer is placed 30 seconds after the
initial event deadline because that SDK treats zero as immediate expiry. No SSE
parser is added to the Gateway. An Agent still has no overall duration limit. This initial-event bound
is an explicit cloud choice, not an exact copy of Codex's unbounded HTTP-header
phase or its connection-only infinite retry feature.

## Run and native task ownership

Run remains a single accepted root work item, with its ordinary native family,
frozen model configuration and existing Session lease/writer. Add an explicit
initial operation: chat or compact. No new scheduler, queue or lease is introduced.

- Active `/compact` is a typed control input to the current Worker and Run.
- Cold `/compact` admits a compact Run through the existing PG claim path. It
  needs no running Workspace VM, does not submit a user prompt, and cannot
  silently enable ordinary generation under a maintenance admission.
- Automatic compaction remains a Pi task inside its existing Run.
- `/usage` is read-only and acquires no execution ownership.

Normal input and cold compact admission share the existing Session serialization.
An ambiguous current-owner acceptance must be resolved by stable request identity
before switching to cold admission. No completed Run or old writer is revived.

## Public Pi seams

Native Pi owns summary selection, generation, retries and summary-write placement.
Create its exported `CompactionTask` through public `Tx.createTask`, initialize
its exported `LiveDoc` status and create a PiCloud command receipt in the same
public transaction. Verify parity with `Conversation.compact()` admission. The
extra receipt carries request identity/fingerprint and native task ID; no separate
compression state machine or result ledger is maintained. No private Pi import,
dependency source patch or committed-write filtering is permitted.

Request attribution must be task/invocation-scoped, not a mutable Conversation
pointer. Use the public RegistryReader/TaskDefinition boundary to decorate native
phase invocation with trusted request provenance, delegating every original phase
unchanged. Retain original task kind/version/checkpoints and native scheduling;
do not mutate the exported builtin definitions. This instrumentation applies on
initial execution and recovery, unlike a selection-only beforeCompact hook.
Public-port contract tests must establish the preservation of native semantics.

Each model request captures its own sampling context, headers, permit and metrics.
One Session writer still serializes their native commits. Compaction completion
is not application: follow its native write Submission to placed/stale/aborted
settlement before presenting a result or releasing otherwise-idle root work.

## User interaction and reads

Use leading-slash composer completion and Enter submission, preserving IME,
ordinary follow-up/steer preferences, drafts and attachments. Commands are not
model-visible Tools or fabricated chat prompts. Show short inline compact status
and a usage view. Active chat accepts ordinary native input during compaction;
cold compact preserves draft editing but defers ordinary sending until settlement.

Usage comes from native committed pi.usage state, with cache input counted as a
subset of total input. Context occupancy is separately estimated from the latest
head and suffix with the appropriate frozen/selected model. API responses use
PiCloud schemas and do not hydrate image pixels or replay lifetime history.

## Adopt before build and acceptance

Reuse pinned Pi 1.0.0 Tasks, document transactions, public registry/model ports,
native write admission and PG/Kafka ownership. Replacing these with another
workflow/store would create competing authorities without meeting a missing need.

Prove concurrent request attribution, admission parity, duplicate/lost ACK,
summary placement/stale results, Stop and restart recovery before wiring live
commands. Verify waiting on both model adapters, read-only cold usage, admission
races and owned Luna/browser continuation. Publish a matched schema/protocol/app
release and preserve user history, images, Workspace volumes and configuration.
