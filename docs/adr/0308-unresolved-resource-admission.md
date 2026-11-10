# ADR-0308: Unresolved resource admission and stock-provider evaluation

Date: 2026-11-10. Status: accepted; implementation and evaluation in progress.
Tracking: [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26),
[portability #27](https://github.com/cookerpapa/pi-managed-agents/issues/27).

## Owner decision

Keep an unresolved development-machine application pending. It cannot be paused,
resumed, cancelled or released before its physical creation outcome is known.
One user may have at most one such unresolved application when admitting a new
machine. This does not cap existing ready machines, serialize unrelated users'
provider calls, limit elastic/subagent creation, or restart uncertain requests.
An exact idempotent retry addresses the existing application. A proved no-effect
or physically cleaned failure frees admission; a transport timeout does not.

Reuse the existing machine state, retained runtime capsule and confirmed
allocation-closure/absence fields. Requested/provisioning machines remain pending;
a non-ready unresolved allocation without a capsule remains pending until closed
and absent. A ready machine with a missing disposable observation is not a new
application. No separate pending-application queue, lease or operation ledger is
introduced. Existing PG admission serialization covers the per-user check before
Project/Workspace creation. Provider calls remain outside that transaction.

The public machine resource adds required `creationPending`. The resource UI
disables another application and lifecycle controls for pending creation, with
one concise explanation. Server checks remain authoritative across tabs and API
replicas. This is a matched public-schema change, with no PG migration or native
Session/Kafka protocol change and no legacy response fallback.

## Deletion and native recovery

Worker-loss closure is an ownership handoff. Existing native recovery intent and
the requeued original Run continue to occupy the Workspace. Explicit Stop still
waits for native cancellation settlement. A terminal-looking Run with pending
recovery or an unfinished writer seal must also block resource mutations.
Use those current fields, not a new boolean derived only from the last seal.

Workspace deletion rejects active/queued/settling/cancelling or recovery-pending
work, children, terminals and dedicated-machine occupancy. It atomically marks
the Workspace deleted under its existing admission lock, preventing new users.
Physical cleanup retains outstanding allocation identities until confirmed
absence; only then may the Volume deletion path remove bytes. Neither user Stop,
Worker closure nor a cancellation acknowledgement proves a physical Tool stopped.
Existing background services and idle compute are retired through resource APIs.

## Evaluation boundary

These product rules reduce concurrency but do not, by themselves, replace all
Cube extensions. Audit actual consumers of allocation receipts, node absence,
Volume-reference reconciliation, finite retention, lifecycle history, connection
credential bootstrap, template cleanup and build/dependency fixes.

Cube already has create/inspect/kill/timeout and Volume reference/delete APIs.
Its official Volume documentation acknowledges response-based count drift; its
binary/RPC Volume Plugin is a supported extension boundary. Prefer that boundary
over a fork where its real failure contracts suffice. A pure external controller
cannot manufacture a missing provider identity or infer absence from inventory
silence. Unknown creation may remain pending under the newly accepted policy;
that is a visible availability tradeoff, not successful cleanup.

Remove Cube patches only after a stock interface/plugin replacement passes the
same relevant acceptance. Do not silently weaken finite retention, recoverable
accounting history or Workspace durability merely to report zero patches. Treat
unreleased master changes and community proposals separately from pinned v0.7.3.
The owner conditions production BoxLite adoption on the stock-provider assessment;
the Android audit can proceed independently without re-enabling its Web picker.

The Android packaging slice selects official UiAutomator2 8.7.3 with existing
Appium 3.8.0. Its published optional Sharp pin replaces our rewritten 8.7.0
manifest. Use ordinary integrity-locked npm installation and remove the custom
extraction/manifest-transform step after dependency and device acceptance. This
does not fork Android/Cuttlefish or change the mobile execution protocol. Do not
upgrade to Appium 4 beta solely to remove a packaging workaround.

## Adopt before build and acceptance

Reuse PostgreSQL transactions and current resource rows, the existing controller,
Cube SDK/plugin interfaces, native recovery intent and the maintained release
operator. No new infrastructure service is needed for admission. Prior primary
evidence is recorded in [the provider assessment](../research/guest-and-resource-boundaries-20261110.md)
and [BoxLite study](../research/execution-boundaries-20261108.md).

Verify concurrent independent API owners in real PostgreSQL, exact retries,
independent users, loss before and after physical creation, protected lifecycle
actions, admission after resolution, and Worker-recovery versus user-Stop deletion.
Verify concise UI controls and retained resource identities. Build/test/live
checks remain serial; routine matched publication and commit pushes are authorized.

