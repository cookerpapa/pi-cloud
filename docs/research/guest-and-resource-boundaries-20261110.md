# Guest execution and provider resource boundaries

Date: 2026-11-10. Scope: Issue #25 / ADR-0307. This is source/API research,
not production acceptance of another sandbox. CubeSandbox remains the backend.

## Decision

Move operation admission, deduplication and exact cancellation to a fixed Guest
service. Invoke its bounded control protocol through ordinary process/stdin APIs;
keep source truncation and HTTPS completion in the Guest application. Reuse Node
SQLite and the existing process/cgroup primitives, rather than adopting a second
workflow history or adding another queue. A normal exec API supplies a process,
but does not enforce PiCloud's Session-log position and operation identity.

Keep allocation closure and Volume reference protection at the resource owner.
A Guest can prevent a duplicate command while its VM exists. It cannot reject a
delayed VM creation after its own VM was destroyed, or prove that another node
has released the same Volume. Moving those checks into Guest code would remove
the protection rather than replace it.

## Maintained candidates and evidence

| Candidate | Observed lifecycle/storage contract | Implication for PiCloud |
| --- | --- | --- |
| E2B SDK/runtime | Create accepts an idempotency key; runtime reservations distinguish pending, complete, mismatch and unknown outcome. Kill uses a lifecycle claim and can return conflict while resuming. | Useful provider primitives, but an idempotent create does not by itself establish PiCloud's permanent close-before-late-create boundary. |
| Daytona hosted API/current clients | Volume deletion is asynchronous; active mounted Volumes reject deletion with HTTP 409. Volumes persist independently and use S3/FUSE. | Closest documented in-use deletion contract among these examples. Verify concurrent mount/delete and failed-node behavior before treating it as equivalent to Cube's recorded-node reference reconciliation. |
| OpenSandbox | Lifecycle CRUD, explicit states, renewable expiration and host/PVC/object-store mounts are separate from execd. | Good adapter separation. A lifecycle API specification is not a distributed physical-absence or Volume-GC proof; underlying Docker/Kubernetes/storage ownership still matters. |
| BoxLite | Separate local/REST volume capability with create/list/get/remove; the pinned API says `force` makes missing-volume removal a no-op. | Can hide runtime mechanics behind a port. This review does not establish cross-node allocation closure or failed-node Volume protection from that interface. |
| Modal hosted API | Sandbox termination can explicitly wait for completion; named Volume deletion affects applications currently using it. | Do not assume every mature provider refuses in-use deletion. PiCloud must retain its own admission policy and use the provider's actual completion semantics. |

Source pins checked:

- [E2B SDK](https://github.com/e2b-dev/E2B/tree/cf7208ad85d5a747ba50ddf4e3bbdd364e4851bf),
  [sandbox create/kill API](https://github.com/e2b-dev/E2B/blob/cf7208ad85d5a747ba50ddf4e3bbdd364e4851bf/packages/js-sdk/src/sandbox/sandboxApi.ts).
  Active Apache-2.0 SDK; retries reuse a supplied create key.
- [E2B runtime reservation store](https://github.com/e2b-dev/runtime/blob/dd5a4803411c21eab272abc45192c96e90a7d182/packages/api/internal/middleware/idempotency/store.go)
  and [kill handler](https://github.com/e2b-dev/runtime/blob/dd5a4803411c21eab272abc45192c96e90a7d182/packages/api/internal/handlers/sandbox_kill.go).
  Redis reservations have bounded retention and preserve uncertain outcomes;
  kill/resume coordination is an explicit responsibility, not an HTTP side effect.
- [E2B Volume delete handler](https://github.com/e2b-dev/runtime/blob/dd5a4803411c21eab272abc45192c96e90a7d182/packages/api/internal/handlers/volume_delete.go)
  records deletion before asynchronous cleanup; the corresponding
  [orchestrator handler](https://github.com/e2b-dev/runtime/blob/dd5a4803411c21eab272abc45192c96e90a7d182/packages/orchestrator/pkg/volumes/volume_delete.go)
  removes the directory. Neither inspected handler proves an active-mount refusal.
  An HTTP 204 is therefore not proof of completed byte deletion on this path.
- [E2B lifecycle history](https://docs.e2b.dev/sandbox/lifecycle-events-api)
  exposes execution identities and events with a default seven-day retention.
  Events can support interval accounting; collection must handle retention gaps.
- [Daytona Volumes](https://www.daytona.io/docs/en/volumes/),
  [current clients](https://github.com/daytona/clients/tree/24979eebde1dd22621aea04d13bb6a808db3e4ac).
  The old `daytonaio/daytona` repository was archived at inspection; do not infer
  current hosted failure semantics from that historical core. The hosted promise
  is useful evidence but has not been crash-tested here.
- [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox/tree/8b76c11212e2405ccd821198563ca40d3c4f17c8),
  active Apache-2.0 project, [API separation](https://open-sandbox.ai/api/).
  Lifecycle and execution are already distinct contracts; mounting a PVC delegates
  protection to Kubernetes/storage rather than making execd its durable owner.
- [BoxLite volume capability](https://github.com/boxlite-ai/boxlite/blob/970d0c6dfe433342ee3b405426779d13f61320c2/src/boxlite/src/runtime/volumes.rs),
  active Apache-2.0 project. An API-level `force` option is not evidence that active
  mounts are forcibly removed or safely reconciled; neither claim is made here.
- [Modal Sandbox contract](https://modal.com/docs/sdk/js/latest/Sandbox) distinguishes
  a termination request from `terminate({ wait: true })`, which returns an exit code.
  This is a useful provider-owned completion contract; timeout/transport loss still
  leaves the adapter uncertain. [Modal Volume contract](https://modal.com/docs/sdk/js/latest/Volume).
  Deletion is irreversible and can affect existing consumers. Hosted API behavior
  is a contract to integrate, not source code adopted by this change.

## Provider adapter requirements

The Guest approach requires a configurable image/service, a usable process API,
stdin transport and independent background execution. Our exact cancellation and
abnormal cleanup implementation additionally requires a trusted root launcher and
cgroup v2. A closed provider that forbids these cannot silently inherit the same
guarantees; use its process-control API with explicit capability tests, or report
the limitation. No model/provider credential or Kafka credential enters the Guest.

The cloud resource port should continue to distinguish: create requested, provider
identity known, actual running, closing, verified absent and outcome unknown.
Close stops new binding admission before physical cleanup. A late create must be
rejected at the destination or reconciled through a provider-owned reservation;
an outside database row alone cannot stop an already-delivered create request.
Volume release requires closed attachment admission plus authoritative references,
not a missing heartbeat or a vanished master route.

For a future backend, contract tests must cover lost create reply, delayed create
after close, lost delete reply, concurrent attach/delete, node restart/metadata
loss, real process exit and retained Workspace bytes. Hosted list/404 evidence
must have a documented authority boundary. A closed provider can supply its own
authoritative termination contract; it need not expose Cube node internals. Until these pass, preserve uncertainty
and avoid destructive release. Source changes here retain the existing Cube
allocation/Volume journals and tests.

## Cost, exit and remaining patches

The Guest is application code installed in the sandbox image; Cube requires no
special Tool submit/cancel/probe API after this migration. It is still maintained
code: local admission metadata, bounded launch/control, exact cancellation and
completion delivery remain necessary. SQLite holds no final result history.

The remaining native patches provide allocation closure, Volume reference
reconciliation, finite expiry and retained raw lifecycle events, plus deployment
fixes. They cannot all be deleted in this slice. A provider with adequate native
contracts can replace those mechanics behind `SandboxLifecycle`; that would be a
separate backend acceptance, not a general-purpose wrapper pretending to supply
missing guarantees. Workspace export and Pi-owned history remain independent of
Guest metadata. Matched rollback requires writer drain and compute retirement;
never mix an old Cube execution manager with the new Guest admission authority.
