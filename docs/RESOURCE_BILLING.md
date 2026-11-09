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

The pinned Cube adapter exposes raw observations from its existing synchronous
metadata database. Native lifecycle hints and thirty-second observations retain
source epoch/boot, resource incarnation, sequence, preceding resource sequence,
observed time and coverage gaps. The journal stores at most 100,000 events and
prunes seven-day history on capture. Bounded history pages and long polling use
the same cursor; expiration or replaced metadata is explicit. No compute interval,
price, Kafka client or metering credential is installed in Cubelet.

PiCloud normally collects and settles each source once per minute, with bounded
catch-up slices when behind. A source cursor and derived receipts commit in one
PG transaction. This cadence does not round usage to whole minutes. Duplicate
pages do not duplicate charges. Compatible consecutive observations establish
bounded running intervals; source restart, a missing predecessor, clock change,
instance/quantity change, unavailable state or an unobserved interval over ninety
seconds remains unconfirmed. Paused/absent checkpoints do not accrue compute time.

Cube's pause/exit timestamps mix physical events with snapshot/recovery bookkeeping.
The adapter leaves `occurredAt` unknown instead of presenting discovery time as
physical stop time. Unproven trailing intervals are unpriced. Metering starts at
first observed evidence, without retrospective charges for an existing machine.
Very short lifetimes missed by the source and loss/expiry of source history remain
completeness limits. Provider monetary bills are optional reconciliation evidence,
not authority for PiCloud customer prices.

The native `picloud_lifecycle_capture_failures_total` counter reports source capture
failures. PG `resource_lifecycle_sources` retains collection/cursor/failure/gap
watermarks, and each metered resource retains only its current lifecycle checkpoint.
None of this is authority for VM destruction, command replay, quota release or
Session lease renewal. Upstream resource metrics retain their monitoring role.

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
Compute collection reads Cube history through its provider adapter and API
credential; Cubelet does not receive an accounting or model credential. Ordinary public reads use existing tenant auth;
only the configured platform owner can inspect another account or configure rates.
Owned acceptance-fixture cleanup is the explicit exception to retaining financial
records and must follow source delivery and physical cleanup confirmation.
