# Resource usage and statements

[ADR-0323](adr/0323-platform-service-minutes.md) defines platform-provided service
minutes independently of physical-uptime observations. Issue #39 is published with
[real Cube, BoxLite and managed Android acceptance](reports/client-service-delivery-20261114.md). Statements
remain informational: payment collection and production tariffs are disabled.

## Compute service

The resource manager records readiness, accepted pause/release and effective
idle expiry. The current provider adapter supplies verified provisioned CPU and
memory; actual utilization and VMM overhead are not the priced quantity.
`resource_metering_resources.service_contract` freezes platform/external billing
and capacity for each allocation. Readiness opens `compute_service_periods`;
pause, interruption and resumption delimit availability periods. These records
are accounting evidence, not another resource scheduler or ownership authority.

The existing passive VM inventory/probes contribute coalesced service checks,
at most one healthy PG update per minute per resource. This uses existing reads,
not Guest traffic, per-Tool billing or Worker-lease queries. A gap longer than
90 seconds ends the old period at its last observation and starts a fresh one.
Unknown tails remain unpriced. This is sampled service availability under an
explicit contract, not proof of continuous second-perfect physical VM uptime.

The independent metering process reads only PG service facts. It has no Cube API
or Redis credential. Once per minute it settles new complete eligible minutes,
carrying partial progress between batches and restarts and waiving a final
incomplete minute. Receipts and period checkpoints commit together under one
resource lock. A shared VM is counted once across Sessions and child Agents.
Rate changes split a paid interval without rounding each segment again.

For an elastic resource, settlement is capped by its effective idle deadline.
An accepted pause/release closes service at the accepted cutoff. Physical cleanup
may finish later, at platform expense. Positive deletion evidence is still needed
to release resource ownership/quota; billing never supplies that evidence.
The original allocation's policy survives later backend catalog edits. New
backend registrations default to external/BYO unless explicitly offered as
platform compute. The initial managed deployment opts into platform service.

## Devices and BYO

Ordinary Android/Linux device registration, connectivity and Tool activity do not
create a compute charge. An administrator may explicitly provide
`computeService: { billing: "platform" }` for a managed Android target that reports
its actual allocation ID and provisioned capacity. Its passive availability
observer uses the same period/receipt path. Physical/user phones and local Linux
executors cannot invent that managed allocation through registration.
`computeService: null` withdraws the service after existing unbind/closure checks.
Changing device compute enrollment requires no active binding.

Android service identity has `workspaceId: null`; it does not fabricate a Linux
Workspace. Receiver/allocation changes split availability rather than extending
an old period. Device unavailability or unregistering is not physical deletion
proof. Model usage and separately provided storage keep their own accounting.
No price settings or metering availability are required for BYO Tool execution.

## Reclamation diagnostics

The resource directory retains bounded request/cleanup/confirmation metadata.
`deleteDispatchedAt` is when management invokes the provider cleanup adapter;
`deletionConfirmedAt` is when it obtains positive absence evidence. The latter
is not an invented exact physical stop time. `physicalStopOccurredAt` stays null
unless reliable provider occurrence evidence is available. Structured
`sandbox.reclamation` logs report transitions and aggregate repeated attempts;
no per-second polling or full Tool/Workspace content enters logs.

Example: ready at 10:00, expired at 10:30, deletion confirmed at 10:30:06 produces
30 service minutes. The six-second cleanup tail is diagnostic, not a customer
charge. Earlier failure and stale observations still follow the gap rule.

## Storage boundary

Storage receipts use provisioned persistent Workspace capacity and retention time.
The VM's disposable system disk is a different resource. [ADR-0301](adr/0301-workspace-capacity-enforcement.md)
uses kernel XFS project quotas for Workspace bytes and upload staging, including
writes through Bash or a terminal. The initial default is 32 GiB; requested growth
has a PG revision and is reconciled to the storage endpoint. A quota is a capacity
ceiling, not a reservation of physical blocks in the backing pool.

A separate trusted `workspace-quota` process shares the persistent Volume mount,
reads enforced capacity and writes source receipts through the same bounded journal.
VM pause/expiry does not stop storage retention. Directory absence and zero kernel
references precede quota removal; missing VM heartbeats never do. The source keeps
accounting/control metadata outside the user's project quota, so a full Workspace
can still be cancelled, expanded or deleted.

`GET /v1/workspaces/:id/capacity` reads the current desired capacity/revision;
`PUT` accepts `{ "minimumGiB": 64 }`. Repeating an older minimum never shrinks a
newer setting. `pending` means the storage endpoint has not yet acknowledged that
revision; it is not an observed disk-usage value. The account's storage statement
meters the actually enforced capacity, not an unfulfilled request.

## Ledger and prices

PG retains resource identities, immutable receipts and immutable price versions
in `resource_metering_resources`, `resource_metering_events` and
`resource_rate_versions`. These records have no cascading dependency on chat or
Workspace history. The resource row serializes interval admission; same-content
retries deduplicate and overlapping confirmed intervals conflict. Different
resources do not share that lock. A GiST range index supports overlap queries.

Compute tariffs specify currency per vCPU-hour and GiB-hour; storage tariffs use
currency per provisioned GiB-hour. Prices apply at their effective instants,
splitting a receipt across changes. Arithmetic uses integer quantities and rates,
with one final truncation below 10^-12 currency per priced segment. Missing rates
stay unpriced. Unconfirmed intervals stay unconfirmed and receive no amount.
Customer quotes and optional upstream estimates remain separate currencies/kinds.

The account menu's **Usage and costs** page separates Models, Compute and Storage.
Resource rows aggregate the selected period by physical resource, rather than
rendering every periodic receipt. Browser export is bounded to the displayed
resource page; the API streams full receipt export. Date ranges select receipts
by their interval start, matching the retained source record. Stable resource-key
pagination avoids reordering a resource every time its next receipt arrives.

- `GET /v1/resource-billing`: `from`, `to`, optional `resourceKind`, `workspaceId`,
  `afterResourceKey`, `limit` (default 50, at most 200).
- `GET /v1/resource-billing/summary`: totals by resource/pricing kind, state and currency.
- `GET /v1/resource-billing/export`: bounded-page NDJSON streaming of raw receipts.
- `GET /v1/resource-billing/rates`: configured immutable versions.
- `POST /v1/resource-billing/rates?tenantId=...`: platform operator only. Example
  fixture, not an actual tariff:

```json
{
  "kind": "customer",
  "resourceKind": "compute",
  "effectiveAt": "2099-01-01T00:00:00.000Z",
  "currency": "CNY",
  "perHour": { "cpuCore": "0.1", "memoryGiB": "0.02" }
}
```

Model and Workspace receipt delivery use the dedicated `metering-ingest-token`.
Compute service facts are committed by resource management and consumed directly
from PG. Cubelet receives no accounting or model credential. Ordinary public
reads use existing tenant auth; only the configured platform owner can configure
rates. Compute receipts cannot be injected through the external Workspace receipt
API. Owned acceptance-fixture cleanup is the explicit exception to retaining
financial records and must follow delivery and physical cleanup confirmation.
