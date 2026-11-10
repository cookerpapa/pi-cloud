# ADR-0307: Guest execution authority and Session activity

Status: implemented; source verified, matched delivery pending. Date: 2026-11-10.
Tracking: [Issue #25](https://github.com/cookerpapa/pi-managed-agents/issues/25).

## Decisions confirmed with the owner

The Worker outer runtime declares that an authorized physical Session family is
still working. The declaration uses the existing fenced Session Kafka producer.
The execution/resource side consumes it without discovering a Worker or querying
its PG execution lease. Pi Core remains unaware of sandbox lifecycle.

Finite elastic retention is the resource policy: when effective renewal stops
until its deadline, Cube may reclaim the VM even if an old Tool remains unconfirmed.
This deliberately replaces the native busy-Tool veto on idle expiry. It does not
limit healthy Run duration, apply idle expiry to dedicated machines, prove process
exit from a missing heartbeat, or authorize quota release without physical absence.
Explicit Stop retains native Pi/Bash cancellation; it does not adopt Codex's
persistent exec-session Stop behavior.

## Session activity and diagnostics

One root writer publishes a small `session_activity` record about once per minute,
including while waiting for models, Tools or native children. Its logical resource
uses contain Workspace/compute-scope identities, never VM endpoints or provider
credentials. Child Conversations add/remove their logical uses under that same
family; parent final text alone does not end activity. Final settlement/draining
stops the timer. Local PG-authorized lifetime and Kafka producer fencing remain
the publication boundary. A definite pre-enqueue refusal can defer maintenance;
an uncertain/fenced producer still retires the whole writer.

Activity is transport control, not native Storage, chat text or a second execution
grant. It keeps its original timestamp; stale/replayed records cannot renew from
replay time. The assigned Projector uses its resource view and coalesces shared VMs.
Missing compute is a no-op, never lazy VM creation. Cold resource-view bootstrap
may read resource metadata; the hot activity path does not query Worker ownership
or execution leases. Binding/lifecycle changes refresh the resource view.

Full probes are separate, on-demand diagnostics. The caller registers its original
reply waiter before publishing `path_probe` through the same writer. Execution uses
the supplied reply destination and current memory binding; it never calls a Worker
management endpoint to prepare a receiver. Confirmation remains disposable HTTP
observation. Neither probe success nor failure is the retention authority.

Remove `ExecutionMaintenance`'s periodic Worker/lease join, passive Worker probe
registration, its request endpoint and obsolete periodic-probe state. Do not keep
both old and new maintenance paths after cutover.

## Guest operation authority

Install a fixed, root-owned Guest service and a small stdin/stdout client in the
tool image. The provider adapter invokes that client through the provider's normal
process API. Only bounded admission/control responses use that stream; Tool bodies,
images and previews retain the existing Guest HTTPS completion path.

The Guest owns operation identity/fingerprint checks, ordered-position admission,
cancel-before-submit rejection, and exact operation cancellation. A bounded local
SQLite store holds executor identity, position boundaries and outstanding operation
metadata. It is not a cloud queue or result store, and contains no transcript or
final Tool output. Use Node's existing SQLite/OS primitives; keep no competing
Cubelet admission implementation.

Persist admission before starting the fixed operation launcher. A duplicate joins
or acknowledges the original admission, never starts the command again. Changed
payloads and stale identities/positions are refused. Lost start acknowledgement
stays ambiguous; callers never automatically resubmit shell effects. Completed
operation rows can be reaped while position boundaries retain replay protection.

Each operation launcher commits claim/completion directly in the same local SQLite
store, so service loss cannot lose completion or cause later cleanup to kill an
already-completed background launch. Recovery rereads the final metadata after
confirming that the registered launcher exited.

Each operation launcher owns its fixed Tool child, original timeout and scoped
control endpoint independently of the initiating HTTP/exec stream and Guest
service process. A service restart reopens its local admission state and never
replays outstanding operations. Exact cancellation can be queued before launch
and addresses the original operation/registration; it cannot kill a reused PID or
completed background work. Missing/corrupt state cannot silently reuse an old
executor identity. Native Pi abort settlement still wins over late replies.

The launcher keeps completion authority outside the untrusted UID-1000 Tool.
Normal cancellation uses the existing Tool AbortSignal/process-group behavior.
Execution timeout and abnormal physical cleanup retain their separate operation
scope. Root-owned per-operation metadata/control sockets provide recovery locators,
not a general process manager exposed to the model.

The adapter classifies definitive refusal separately from unknown launch/delivery.
There is no result GET/cache or per-Tool PG ledger. A missing Guest service/VM may
prevent a callback; the original deadline and existing UNKNOWN/environment-recovery
path remain the fallback. Source truncation and immutable image references remain.

## Recovery binding identity

Live VM-loss acceptance exposed an old address reuse race: resource cleanup can
remove a closed binding before an unconfirmed Tool settles. Reusing that logical
request ID may create another PG row which the ordered view correctly refuses to
reopen. Native continuation then waits indefinitely despite a fresh physical VM.

When recovery still references the current logical binding, the Worker runtime
selects a new binding request ID once for that recovery. Retries keep that new ID;
a replacement Worker already starts with a fresh address. The execution side can
reuse healthy compute or prepare new compute under existing resource authority.
Accepted operations retain their original ID, target, reply topic and deadline;
no Tool intent is republished. Late withdrawal for an older binding cannot
invalidate the replacement address. This uses the existing recovery document,
logical environment port and immutable-binding rule, without new PG tables,
leases, schedulers or permanent closed-binding history.

## Cube boundary

Remove the native managed Tool submit/cancel/probe implementation, its execution
manager and native completion fallback once the Guest path passes the same contracts.
Normal process/data APIs carry the fixed Guest client. Executor identity comes from
the Guest; allocation renewal uses the allocation's existing identity/recorded-node
authorization rather than an execution-manager boot token.

Cold provider data access recovers the original credentials from the existing
allocation receipt: ordinary VM inspection intentionally omits them. This is
read-only resource bootstrap, not a Worker/lease query or a VM connect/resume.
Managed allocations disable traffic-triggered auto-resume, including dedicated
machines; only the lifecycle owner may resume them under PG user intent. Thus a
probe or delayed control request cannot undo a deliberate pause.

Cubelet's allocation journal remains the sole finite expiry clock. Expiry atomically
checks/marks the allocation closed, without consulting a busy-Tool map. Continued
Tool execution does not override an expired retention policy. Physical closure,
late creation fencing, Volume reference reconciliation and raw lifecycle history
remain native resource responsibilities in this slice.

Resource closure and Volume protection are assessed against other provider APIs;
no alternate backend is deployed and no physical proof is removed on the strength
of a diagnostic or an API request acknowledgement. The final assessment distinguishes
provider promises, source-confirmed behavior and unverified failure cases.

## Adopt-before-build and delivery

Reuse Pi's public Tool interfaces, the existing Session writer/reply transport,
Guest Tool implementation, HTTPS completion service, and ordinary provider process
APIs. Cube's pinned process API supplies process/stdin/output primitives, not the
required durable operation/ordered-close identity. E2B/OpenSandbox execution APIs
and provider lifecycle/Volume capabilities are compared in the accompanying research.
Adopting another cloud workflow history or general scheduler would duplicate Pi/PG/Kafka
authority; the custom addition is confined to Guest operation admission/control.

Use a matched protocol cutover with a new Session transport version. Materialize
protected old live suffixes and drain/fence writers before replacement. Preserve
accounts, configuration, retained images and Workspace bytes. Remove superseded
native code and transport paths rather than introducing compatibility modes.

Acceptance includes same-ID duplicates/changed bytes, cancellation preceding submit,
Guest/caller loss, original-topic Worker recovery, completed background services,
expiry during an unconfirmed operation, healthy activity through silent model/child
waits, stale activity replay, pure chat with no VM, images/output bounds, and exact
resource cleanup. Source and live tests run serially; delivery requires the maintained
matched release and real Cube/Luna evidence. The 131 MiB cold model upload stays deferred.
