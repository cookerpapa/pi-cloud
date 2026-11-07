# Resource usage and statements

[ADR-0300](adr/0300-resource-usage-receipts.md) defines source resource receipts.
This implementation is pending the consolidated matched release. It provides
informational statements, not real payment collection or a published tariff.

## Compute

Cubelet records the accepted workload CPU and memory allocation over verified running intervals.
Host/VMM overhead and snapshot rounding are excluded from the billed quantity.
It reads native lifecycle/resource metadata and confirms running state against
the existing local task interface. The source does not query PiCloud PG, invoke
the management API or depend on a particular Session/Run. A VM shared by several
conversations has one allocation identity and one meter.

Every 30 seconds, and on coalesced lifecycle changes, a local bbolt transaction
records the receipt and advances its cursor together. An independent sender
delivers up to 128 receipts to `metering:3000/internal/v1/resource-metering`.
Only PG acknowledgement removes receipts. The 65,536-record source buffer is an
operational capacity bound; reaching it preserves pending facts and marks later
unobserved intervals uncertain. It does not terminate VMs or cancel Tools.

Collector restart, instance replacement, clock discontinuity, collection failure
and unavailable observations leave explicit unconfirmed gaps. An observation
interval longer than 90 seconds cannot be assumed continuously verified. This
changes accounting confidence, not the permitted lifetime of an Agent or VM.
Paused resources do not accumulate compute time. Cube's pause/exit status timestamps
mix physical events with later snapshot/recovery bookkeeping. The adapter therefore
keeps the final unsampled interval unconfirmed rather than billing cleanup time.
Metering begins at first verified capture, without retroactive charges for an
existing machine. Very short lifetimes lost before the first source observation
and loss of the node metadata store are limits on completeness.

The existing `/v1/metrics` endpoint exposes
`picloud_resource_metering_pending` and
`picloud_resource_metering_capture_failures_total`, completed collection cycles and
a coherent delivery barrier (NaN when capture/delivery is unconfirmed). These are delivery diagnostics,
not authority for VM destruction, quota release or replay. Upstream
`/v1/metrics/resource` retains actual CPU/memory observations separately.

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

Source delivery uses the dedicated `metering-ingest-token`, shared only by the
trusted provider, Cube source adapters and receiver. Cube does not receive the
model API key for accounting. Ordinary public reads use existing tenant auth;
only the configured platform owner can inspect another account or configure rates.
Owned acceptance-fixture cleanup is the explicit exception to retaining financial
records and must follow source delivery and physical cleanup confirmation.
