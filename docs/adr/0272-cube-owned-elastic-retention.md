# ADR-0272: Cube-owned finite retention for elastic VMs

Status: implemented and deployed as `elastic-retention-03ce2f23`; source, matched
artifact and owned live acceptance passed. See the
[delivery record](../reports/elastic-retention-delivery-20261023.md).
Date: 2026-10-23.

### Implementation refinement: reuse the node allocation journal

Source inspection found a smaller, stronger integration than relying on the
generic Redis timeout refresh: Cubelet already has synchronous managed-allocation
metadata, irreversible Close, an existing ten-second maintenance loop and the
accepted Tool admission mutex. Store the finite deadline on that same node
allocation record and expire it from that maintenance loop. Extend the existing
managed-allocation API with renewal rather than creating a second VM scheduler.
CubeMaster's existing reconciliation already adopts node-initiated closed/absent
allocations and repairs its Volume references.

For these managed allocations, Cubelet is the only deadline authority; generic
Cube lifecycle auto-timeout stays disabled so two components cannot race to
expire them. The effective PiCloud policy is finite even though the generic
Cube timeout is `-1`. Dedicated allocations have no retention deadline. Renewal
acknowledgement follows the synchronous node metadata commit, and expiration
shares admission with fixed Tools. The generic refresh endpoint's false-success
behavior therefore does not enter the new retention path. This refinement keeps
the approved Worker/Kafka/Projector/Cube ownership, cadence and outage behavior.

The existing Cube API authorization callback must admit the exact managed renewal
route. Its image joins the matched artifact set, scan and deployment so a new
Cube protocol cannot silently retain an older callback that rejects renewal.

## Decision and scope

Elastic VMs have a finite retention deadline managed by Cube. Authorized active
Session work renews it through the existing Worker → Kafka → Session Projector
path, including silent model waits and final-answer streaming. Cube expires an
unused VM without requiring a Worker to send a completion notification or the
PiCloud Control Plane to run an idle-deadline scanner.

The owner accepts that a prolonged break in renewal delivery can permit elastic
compute to expire while a Worker is still waiting for a model. This is resource
retention policy, not evidence that the Worker or VM has died. Workspace Volumes
and conversation history outlive expired compute. An expired physical identity
cannot be reopened by a late renewal or reused for arbitrary Tool replay.

Dedicated development machines remain explicitly managed, non-expiring resources.
Their host-reboot recovery gap is a separate backlog item: this change does not
make a stopped dedicated VM resumable or fix the current affected conversation.
No overall Agent runtime limit is introduced.

Matched delivery must preserve existing dedicated Workspace bytes. An already
failed machine may remain as a failed control record after PG closes allocation
admission and the original node confirms physical absence. The release drain
gate permits that closed, holder-free failed record only with no runtime identity;
the existing all-node empty inventory and writer-drain checks still apply. Do not
invoke the public machine Release action to obtain this state: Release deletes
the Workspace. This does not add automatic dedicated-machine recovery.

This is a narrow amendment to ADR-0209/0223's controller-owned idle
retirement and ADR-0201/0211's observation-only probes. The existing diagnostic
probe does not acquire destruction authority. A separately typed retention
intent uses the same transport and scheduling facilities. Other VM creation,
binding, explicit release, uncertainty, quota and Volume-closure rules remain.
The corresponding AGENTS.md rule describes the deployed contract; the controller
no longer owns elastic idle reclamation deadlines.

## Adopt-before-build evidence

- Reuse Cube's [lifecycle manager](https://docs.cubesandbox.com/guide/lifecycle),
  its finite idle timeout, existing management API and physical cleanup. The
  deployed source is pinned to `8721dd151971ce3c2966482bbd32904ad98f378e`
  (Apache-2.0), with the maintained PiCloud patch set. Current upstream docs are
  reference evidence, not proof of the deployed version's behavior.
- Retain the existing control/observation split illustrated by
  [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/).
  Adopting another Operator or scheduler would duplicate current PG/Cube ownership;
  the existing build-versus-adopt investigation is recorded in ADR-0223.
- Pinned `CubeAPI/src/handlers/sandboxes.rs` exposes
  `POST /sandboxes/{id}/timeout` and `/refreshes`. However,
  `CubeMaster/pkg/service/sandbox/sandbox_timeout.go:refreshTimeoutMeta` can return
  a calculated deadline after persistence failure, while
  `CubeMaster/pkg/lifecycle/store.go:PublishUpdate` logs HSET/XADD failures without
  returning them. An HTTP success is therefore insufficient renewal evidence.
- The pinned lifecycle sweeper selects an expired registry snapshot before
  acquiring its action lock. Renewal and beginning expiry must be checked against
  the same current authoritative state. Its ordinary timeout Kill also needs
  integration with PiCloud's managed-allocation Close contract (ADR-0223/0265).
- Prefer an applicable upstream fix over a new patch after comparing the current
  upstream implementation. Keep any necessary integration bounded and pinned;
  do not add another timer service, event broker or storage authority.
  The October 23 comparison at upstream
  `c4340c2ebbf6a3cc9c41aee330f9aaf329bef2dd` still finds warning-only HSET/XADD
  handling in `PublishUpdate`; the maintained implementation uses the existing
  synchronous node journal instead of depending on that acknowledgement.

## Product behavior

Initial parameters are a 15-second Worker renewal cadence, coalesced to at most
one ordinary renewal per physical VM per 30 seconds at the Projector, and a
15-minute finite retention window. First activation/attachment can renew
immediately. These are operational settings, not limits on task duration. Use
the existing retention configuration as one source, replacing its old name if
necessary rather than keeping an alias for the removed behavior.

- A pure-chat task with no existing VM creates no VM, allocation or fake Tool
  invocation. There is nothing to renew.
- If the Workspace already has a usable elastic VM, an active conversation can
  keep it available without needing a new sandbox Tool call. Obtain a lightweight
  reference to existing compute through the execution-registration/current-resource
  path; this reference grants retention only, not Tool execution.
- New sandbox Tools still materialize compute lazily. Successful materialization
  supplies the exact physical target for subsequent renewals.
- One physical Session family renews its active compute references. Native child
  Conversations do not become new cloud leases or per-child producer identities.
  A parent's final text does not end renewal while its family still has work.
- Shared VMs use the latest valid deadline from all users. Ending one Session
  stops its renewal; it never shortens another Session's retention. A final fresh
  renewal at ordinary settlement may preserve the full idle window, but cleanup
  must also work if that final message is lost.
- An already accepted, still-running fixed Tool remains real Cube-local activity,
  even if it prints nothing or its original Worker disappears. It retains the
  existing Tool timeout/cancellation/settlement contract, not an infinite external
  pin. Completion, cancellation and executor loss remove that local activity.
- Human terminal lifetimes and real preview traffic participate through their
  existing gateways/data paths and the same Cube retention adapter. An open
  conversation page, browser animation, inventory query, health probe or idle
  background server alone is not renewable activity. Detached servers needing
  continuous availability belong on dedicated machines.

Local Tool activity can keep a VM alive during a broken Worker/Projector path;
once no Tool or human activity remains, the last finite retention window bounds
idle retention. Persistent infrastructure failure can delay physical destruction;
it never justifies pretending that quota or storage references were released.

## Transport and expiry contract

1. Add a PiCloud-owned `runtime_keepalive` accepted fact alongside diagnostic
   `path_probe`. Reuse the existing physical-Session writer, periodic scheduling,
   Kafka partition and Projector consumer group. Coalesce ordinary generation
   activity; quiet work still emits renewals. Keep only current execution identity,
   bounded existing-resource references and the original activity time. No text,
   reasoning, arguments, image bytes, native/display sequence or PG history row.
   Split/rotate large reference sets without silently omitting active children.
2. Bootstrap each admitted writer/Workspace or compute-scope reference once from
   the existing resource rows, caching both a physical capsule and absence. Ignore
   resources created after the original activity timestamp. Update references on
   actual binding/resource changes using the current management/control-change
   mechanisms. This is one bootstrap read per reference, not one read per pulse. Projector's renewal
   hot path uses current memory views; it does not query PG for every pulse and
   does not invent a second resource queue or per-pulse receipt table.
3. Projector verifies its partition ownership, current Session writer, open
   reference and physical generation. Coalesce by physical VM in a bounded map
   and perform cancellable Cube calls outside the partition's critical path.
   A stalled Cube must not stall history projection or buffer unbounded renewals.
   Losing a pending renewal on Projector restart is acceptable under this policy.
4. Renew an absolute deadline derived from the original accepted activity time
   plus the configured window, not from when an old record is replayed. The Cube
   adapter must preserve the same deadline on retry. Reject stale/future activity
   outside the documented clock-skew/freshness envelope; do not silently clamp an
   old event to the current time. Start with the existing 45-second freshness /
   five-second future-skew bounds and verify them under delayed delivery.
5. Cubelet owns one deadline in its existing synchronous allocation journal. Updates are
   monotonic for one immutable physical allocation: `max(current, requested)`.
   A delayed request cannot shorten newer retention, extend another VM generation,
   wake a paused dedicated machine, or reopen a closing allocation. No per-heartbeat
   PG write, secret/signature system or second durable deadline is introduced.
   Sessions sharing a VM can occupy different Kafka partitions: their offsets are
   not globally comparable. Validate each source in its own scope, then combine
   its eligible absolute deadline at the physical VM.
   A pulse accepted before normal Run settlement can still apply its original
   finite deadline afterward. Settlement prevents new pulses, not delivery of an
   already authorized retention intent; physical allocation closure still wins.
6. Renewal acknowledgement must reflect successful authoritative state change,
   with publication failures recoverable through the existing lifecycle mechanism.
   Recheck the latest deadline under the same admission boundary that starts
   expiration; a stale sweeper snapshot cannot override an accepted renewal.
   Validate the fixed-Tool/terminal activity precondition at this boundary too.
7. At expiration, Cube closes new-effect admission and uses the existing managed
   allocation Close/physical cleanup path. Once closure wins, a renewal is rejected.
   Timeout cleanup deletes compute only, never the independent Workspace Volume.
   Retain immutable closure identity through uncertain cleanup and retries.
8. Control Plane reconciles Cube's reported closure using existing resource records
   and current observation paths. It closes stale routing and frees capacity only
   after confirmed absence on the recorded node. A missing heartbeat or master
   listing is never substituted for that proof.

Clock synchronization is a prerequisite of timestamped finite retention. Cube
restart reloads recorded deadlines; neither restart nor Kafka replay grants a new
15-minute lifetime by itself. Diagnostic sweeps do not renew expired resources.
Any startup grace must be explicit, finite and tested; it cannot restore `-1`.

## Recovery and model-visible behavior

On the next legitimate Tool request, an expired elastic runtime is retired through
the ordinary physical-absence boundary before another allocation can mount its
Volume. A new VM gets a fresh identity and the same Workspace Volume. A cached
handle to a closed VM must not block all future work or be treated as usable.

Retain Pi's native distinction between a confirmed not-started Tool and an UNKNOWN
side effect. A rejected handoff must not silently replay arbitrary shell commands
on the replacement VM. Use the existing World State boundary to report changed
runtime continuity to the model; files persist, processes and memory do not.
Because activation is lazy, that notice can first appear at the clean model
request boundary following the first sandbox Tool, as in the current implementation.

## Implementation slices

| Slice | Concrete work | Acceptance gate |
|---|---|---|
| E1: Cube contract | Characterize false-success renewal, retry/reorder, expiry races and managed Close; adopt/fix the pinned native implementation behind `SandboxProvider` | Durable update failure is observable; identical retries do not move expiry; closure cannot be undone |
| E2: Active-work references | Add the existing-VM retention reference and finite keepalive fact on the current Session publication path; cover silent model/child waits | Pure chat creates zero VMs; an existing VM is retained; family/child references remain correctly bounded and current |
| E3: Projector delivery | Current-memory lookup, per-VM coalescing, freshness validation, bounded asynchronous Cube renewal | No per-pulse PG queries/writes or extra consumer group; blocked Cube does not stall canonical projection |
| E4: Cube activity and reclamation | Integrate accepted fixed Tools, terminals and preview activity; exclude diagnostic traffic; reconcile expiry and cold activation | Worker loss eventually releases idle compute; a real long Tool is not mistaken for idle; Volume survives |
| E5: Remove old authority | Declare finite managed retention at creation; disable generic Cube auto-timeout; remove controller idle deadlines and warm-count eviction | Cubelet is the sole managed idle-expiry owner; dedicated machines have no deadline; no legacy decoder or dual idle reaper remains |
| E6: Matched release | Required source/fault/native contracts, scanned matched Cube/Worker/Control Plane/guest artifacts, owned live acceptance and cleanup | Recorded release evidence and preservation checks; no half-upgraded readers or native executors |

E5 removes the idle-time authority, not the warm-runtime lookup map, resource
ownership checks, capacity admission, explicit user release or failed-closure
retry machinery. The implementation removes warm-count/LRU eviction too: the
old predicate only knew Tool/terminal binding occupancy, so it could evict a VM
retained by pure-chat work. Configured capacity waits for confirmed release;
the ordinary installation has no product count quota. No new VM placement scheduler.

## Required verification

- Silent model work and final-answer streaming longer than the retention window;
  periodic renewals keep existing compute alive without relying on output rate.
- Pure chat with and without a pre-existing warm VM; neither case creates compute
  solely to send a heartbeat. Verify actual warm-reference admission.
- Shared VM with two Sessions; stop/crash one and retain the other. Multiple
  native child compute scopes, including a parent that finishes first.
- Quiet accepted Bash longer than the idle window; terminal-only and preview-only
  activity. After all sources cease, expiry occurs without an end notification.
  Diagnostic probes alone cannot retain a VM indefinitely.
- Worker death, Kafka publication loss, Projector pause/restart, Cube API failure,
  lifecycle-state write failure and lifecycle-manager restart. Test outages both
  shorter and longer than the window; report retained active work separately from
  idle-expiry outcomes. No wall-clock ceiling is added to an active Agent.
- Original-timestamp replay, duplicate requests, reordering, old Worker identities,
  old VM/node boots, clock skew and an idle-expiry/new-Tool race. An already closed
  target never comes back; a replacement never overlaps unconfirmed old ownership.
- Expiry retains exact Workspace file bytes. A subsequent legitimate Tool uses
  a fresh VM and the existing native environment-change notice. UNKNOWN operations
  are not automatically executed again.
- Confirm physical cleanup before quota release and preserve Volume references
  through unavailable nodes. Preserve accounts, provider/model settings, credentials
  and existing user Workspaces during delivery.

Use short windows and controlled clocks for bounded fault tests, then a limited
real-duration 15-minute idle sample and a real GPT-6 Luna continuation. Do not repeat
the entire paid suite for every slice or label an earlier failed invocation passed.

## Rollout boundary and remaining work

This plan changes the private accepted-fact and Cube management contracts. Update
the maintained matched versions and remove the superseded decoder/idle logic in
one drained cutover; preserve current data authorities and the Session writer fence.
Rollback requires a matched set, not simultaneous old/new reclaimers.

The current dedicated-machine `release` operation deletes its Workspace. It is
not an upgrade cleanup workaround for the stopped user environment. Before any
rollout requiring zero physical VMs, resolve its compute disposition through a
data-preserving lifecycle procedure or an explicit separately authorized deletion.
The October 22 deletion authorization concerned a different, already removed
Workspace. Merely recording this plan changes no VM, stored configuration or
running service.
