# Resource usage and statements

[ADR-0300](adr/0300-resource-usage-receipts.md) defines source resource receipts.
This implementation is pending the consolidated matched release. It provides
informational statements, not real payment collection or a published tariff.

## Compute

Cubelet records allocated guest CPU and memory over verified running intervals.
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
Paused resources do not accumulate compute time. A known native pause/exit time
can settle the verified prefix; mere absence cannot invent an exact stop time.
Metering begins at first verified capture, without retroactive charges for an
existing machine. Very short lifetimes lost before the first source observation
and loss of the node metadata store are limits on completeness.

The existing `/v1/metrics` endpoint exposes
`picloud_resource_metering_pending` and
`picloud_resource_metering_capture_failures_total`. These are delivery diagnostics,
not authority for VM destruction, quota release or replay. Upstream
`/v1/metrics/resource` retains actual CPU/memory observations separately.

## Storage boundary

Storage receipts use provisioned persistent Workspace capacity and retention time.
The VM's disposable system disk is a different resource. The storage source and
real capacity enforcement are the separate [Issue #8](https://github.com/cookerpapa/pi-cloud/issues/8)
slice; defining the receipt dimension does not claim that an unenforced directory
already has a capacity guarantee.

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
