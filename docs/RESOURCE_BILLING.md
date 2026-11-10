# Resource usage and statements

[ADR-0306](adr/0306-runtime-decoupling-and-continuation.md) separates provider
lifecycle evidence from PiCloud interval calculation and pricing. Delivery status
and verification are recorded in the [current report](reports/runtime-decoupling-20261109.md).
Statements remain informational: payment collection and production tariffs are disabled.

## Compute

The independent metering process reads a provider-owned lifecycle port. It does
not depend on Session activity, a running Agent, the public API or diagnostic
probes. A shared VM has one allocation identity and one meter. Quantity is the
accepted workload CPU/memory allocation, excluding host/VMM overhead and snapshot
rounding; actual CPU utilization is a separate monitoring measurement.

Under [ADR-0309](adr/0309-stock-sandbox-contract.md), the stock Cube adapter reads
native API inventory and the native Redis lifecycle channel. The first successful
creation receipt registers its bounded provider-id/tenant/Workspace mapping in
the existing accounting resource directory. This is attribution metadata, not
an interval, price or additional resource authority. It survives removal of the
active management binding.

Collection uses bounded pages and normally runs once per minute. Each observation
page and its opaque cursor commit together in PG. A lost page or stale collector
cannot duplicate settlement. Native notifications may be lost or trimmed; absence
of an event or inventory entry does not prove resource removal.

Stock Cube does not supply verified continuous physical-time coverage. This
adapter therefore marks sampled compute intervals `provider_observation` /
`unconfirmed` and **does not price them**, including time between two running
samples. Missing quantities are not replaced with a default VM size. Native
explicit deletion evidence can settle resource state, but discovery time is not
presented as a precise physical stop timestamp. Model and Workspace-capacity
accounting retain their existing evidence and pricing behavior. Stronger compute
pricing requires an explicitly agreed provider coverage or estimation contract.

PG `resource_lifecycle_sources` retains observation cursors and failure/gap
watermarks; each resource retains its current observation checkpoint. There is no
PiCloud lifecycle journal, pricing code or accounting credential inside Cubelet.
Accounting never authorizes VM destruction, Tool replay, quota release or Session
lease renewal.

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
Compute collection reads stock API inventory and native Redis notifications through
its private adapter credentials; Cubelet receives no accounting or model credential. Ordinary public reads use existing tenant auth;
only the configured platform owner can inspect another account or configure rates.
Owned acceptance-fixture cleanup is the explicit exception to retaining financial
records and must follow source delivery and physical cleanup confirmation.
