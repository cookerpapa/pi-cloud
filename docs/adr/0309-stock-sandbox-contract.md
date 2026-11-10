# ADR-0309: Stock sandbox APIs and conservative external ownership

Date: 2026-11-11. Status: accepted; implementation in progress.
Tracking: [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26),
[BoxLite / Android #27](https://github.com/cookerpapa/pi-managed-agents/issues/27).

## Scope of the revised decision

After reviewing the complete Cube patch inventory, the owner approved removing
the private Cube contracts rather than reproducing every guarantee in another
process. This supersedes ADR-0308's assessment-only restriction. Both source patch
files and equivalent hidden build/source rewrites must disappear. Pin upstream
artifacts and keep their provenance. PiCloud's Guest application, supported Volume
plugin, provider adapter and deployment configuration remain owned integration
code; they are not forks of the sandbox engine.

Keep Pi public SDK use, one Session writer/lease, Kafka intent-before-dispatch,
Guest operation admission/cancellation, independent completion, source output
bounds and native continuation. No raw Tool-result store or second scheduler is
introduced. Unknown external effects are never replayed automatically.

## Resource admission and creation

The ADR-0308 per-user pending-machine gate remains. Persist a bounded creation
intent before sending; authorize at most one uncertain native create attempt from
that intent. A successful response records the provider's actual sandbox identity
and private connection data. Cloud request identity and provider resource identity
are separate; no adapter assumes an upstream-generated ID equals the cloud UUID.

Recovery first uses retained provider data, then supported read-only lookup. It
does not call create again merely because a lookup returned nothing. Missing or
conflicting identities leave creation unresolved, retain ownership/capacity and
may require operator reconciliation. Do not claim exactly-once resource creation
inside the provider. Provider-internal retries and orphan discovery are part of
the adapter contract evaluation, not grounds to invent a successful outcome.

Remove the immutable create-before deadline/close RPC as a provider requirement.
The user accepts pending uncertainty instead of requiring the destination to
permanently reject every delayed creation after a preceding close. User actions
cannot retire an unresolved application. Worker-loss closure continues to retain
the original logical Run and its resources; explicit Stop waits for native
settlement and remains separate from VM lifecycle.

## Resource deletion and Volume ownership

The existing resource controller is the only external lifecycle owner. Reject
active/recovery-pending work, close new resource admission, settle known provider
operations, then delete unused storage. Provider-confirmed successful destruction
is evidence under that provider's documented contract; missing probes, transport
failure and ambiguous lookup/404 remain unknown. Do not claim an independent
kernel-level absence proof when using only native provider APIs.

Use Cube's supported Volume Plugin for required backend-specific protection.
Durable attachment holds precede exposure of a Workspace path. Attach and Destroy
share deletion admission; a deleting Volume refuses later attachment. Detach
releases only its exact recorded holder; duplicate/late calls cannot remove a new
attachment. Lost metadata, unfinished detach or an unreachable node retains an
uncertain hold. Native basic reference checks may additionally delay cleanup.

This permits a bounded plugin/external-storage implementation but not a second
Cube scheduler, a shadow per-Tool ledger, or guessing zero holders from a missing
reply. At cutover there is one physical attachment authority for managed Workspace
bytes. Persistent Workspace data remains in the existing storage pool, without
per-Run copies or another archive head. Native bugs/uncertainty can leave cleanup
pending; automatic recovery of every failure is no longer promised.

## Connection, timeout and diagnostics

Warm the trusted Guest-control data connection from the already retained encrypted
capsule. Do not call a custom allocation receipt API just to recover credentials,
and do not use connect/resume as a diagnostic. Explicit lifecycle resume remains
subject to user intent and resource admission.

Use provider-native timeout and renewal behavior. Execution-side eligibility
still comes from fresh Session resource activity, and on-demand path probes stay
diagnostic. Document native traffic refresh and renewal precision rather than
maintaining a second Cube allocation clock. Dedicated machines retain an explicit
non-expiring policy when supported; no total Agent Run duration cap is added.

## External observations and accounting

Remove Cube's private lifecycle-history journal/API dependency. An independent
provider adapter collects native lifecycle notifications and current observations,
retaining its external cursor/evidence in the existing accounting infrastructure.
It never controls VM lifetime. Native publication can be incomplete; do not
manufacture missing physical transitions or claim exact physical-runtime history.

Source gaps, disconnected periods and unverifiable intervals remain unpriced.
Any estimates must be explicitly identified as estimates, not confirmed physical
usage. Do not change tariffs or enable payment collection implicitly. Model
metering and persistent Workspace-capacity receipts keep their current contracts.

## Native cleanup and build boundary

Use ordinary pause/resume/kill and native template/artifact operations, removing
managed allocation bridge code. Prefer an upstream revision with the required
fixes. If a native cleanup cannot be confirmed, keep its work pending instead of
adding another private state machine or discarding ownership evidence.

Dependency/build repairs are included in the inventory. Do not move a go.mod
patch to an overlay, sed command or renamed file to claim zero patches. Use a
pinned upstream artifact or unmodified source build; report any required release
gate that the stock artifact cannot pass. Keep image construction for the owned
Guest/plugin separate from changes to Cube engine source and dependency graphs.

## Adoption evidence and cutover

Reuse current PG ownership/admission, the supported Cube SDK/plugin surfaces and
the existing Kafka/Pi runtime. Evidence and remaining questions are in the
[complete inventory](../research/cube-patch-inventory-20261110.md) and
[stock boundary study](../research/stock-sandbox-boundaries-20261110.md).
The approved weaker failure policy is explicit; it must not be confused with
reimplementation of the previous node-allocation journal outside Cube.

Implement one complete vertical slice at a time and run all heavy checks serially.
Require stock API/Guest and plugin tests for creation reply loss, no repeated
uncertain create, duplicate/late attachment, unknown deletion, original-operation
Worker recovery, native Stop, timeout, images and preserved storage. Demonstrate
accounting gaps without invented fees. Before matched cutover, use the old serving
runtime to drain/fence writers and positively clean old compute; preserve accounts,
credentials, configuration, retained attachments and Workspace bytes. Do not mix
old managed-identity records with the new native protocol or add a fallback.

BoxLite is an explicit subsequent adapter, not a silent fallback. Android uses
unmodified engine/automation artifacts with its existing owned executor. The
hidden Android product picker stays hidden, and its originally stopped device
returns to the stopped state after owned acceptance.

## Source progress

The first vertical slice replaces the cold Guest-control allocation-receipt
lookup with retained encrypted resource capsules. One bounded cold resource read
checks the exact API/node/VM and stored resource identity; cached execution has
no new SQL. Missing/unavailable credentials refuse before Tool dispatch. It never
calls connect/resume as a probe. Thirty-eight focused transport/capsule tests and
the Sandbox-control type check pass. Allocation lifecycle, retention, Volume and
history extensions remain until their following replacements; no deployment or
zero-patch completion is claimed by this source milestone.

The second source slice uses the native `POST /sandboxes/:id/timeout` interface.
Elastic creation supplies its idle timeout; dedicated creation retains `-1`.
The adapter subtracts activity age before renewal and rejects expired activity.
Interactive connections renew through the same native API; diagnostic probes do
not. The custom renewal client and its authorizer permission are removed. The
private allocation lifecycle and journal source remain until the full cutover,
so this slice must not be deployed over still-running managed-retention VMs.
Its 120 focused client/provider/authorizer tests and type check pass.


The third source slice separates the PG creation permit from the provider's native
identity. Only its first owner may issue POST create. Recovery uses an early
encrypted receipt or a unique native metadata match; empty/ambiguous discovery
never repeats creation. Preparation records the real provider identity first.
Schema 216 removes the former protocol/deadline columns only after a drained
cutover, and private resource capsules advance to version 3 without a compatibility
reader. Native DELETE failures and inventory gaps retain ownership. Resource
health no longer creates an untracked probe VM; owned bootstrap attests the Guest.
Native lifecycle observation/expiry evidence and the release operator are still
being migrated, so this source slice is not a deployable matched release alone.

The supported Volume Hook does not provide an attachment-incarnation id. The
external plugin therefore publishes a unique durable hold per successful Attach
and returns its opaque receipt as native hook metadata. Repeated Attach may leave
an extra hold if its reply is lost; this is explicitly preferable to releasing a
new mount on a late Detach. Missing hook metadata, missing hold directories or
unconfirmed old-node cleanup cannot authorize deletion. The old release must
retire compute before the one-time attachment-directory initialization at cutover.
