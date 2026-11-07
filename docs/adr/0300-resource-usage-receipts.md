# ADR-0300: Source resource receipts and informational statements

Status: accepted; deployed and verified on 2026-11-07.
Date: 2026-11-07. Tracking: [Issue #7](https://github.com/cookerpapa/pi-cloud/issues/7).

## Pricing boundary

Compute pricing uses the accepted workload CPU and memory allocation (excluding
host/VMM overhead and snapshot rounding) multiplied by confirmed
running time. Actual CPU-seconds and sampled memory use remain operational
measurements. Do not add guest and host/VMM scopes or charge a shared VM again
for each Session using it. The allocation UUID identifies the physical purchase;
tenant and Workspace ownership are frozen at creation. A replacement allocation
is a new resource. Pause stops running-time accrual; retained Workspace capacity
is separate storage consumption, handled in Issue #8.

The user-facing disk capacity will describe the persistent Workspace, not the
independent disposable system layer. System-layer capacity is platform overhead
for the chosen compute profile, not an implied Workspace limit.

No real prices, wallet enforcement, invoices, payments or taxes are enabled.
Missing or incomplete observations do not become estimated customer charges.

## Adopt-before-build

[OpenCost's specification](https://opencost.io/docs/specification/) distinguishes
allocated resource-time from actual use and treats provisioned persistent storage
as a capacity allocation. Adopt that distinction. OpenCost's Kubernetes collector
would see a Cubelet Pod, not the individual KVM allocations and persistent POSIX
Workspaces inside it; installing it does not supply the missing tenant/lifetime
facts. Cube v0.7.3's native resource metrics provide operational observations but
no durable billing receipt history. Lago/OpenMeter remain evaluated downstream
options under ADR-0297/0298; neither recovers an uncaptured source fact.

Retain a bounded Cube source adapter over its existing pinned bbolt metadata
store, native lifecycle status and resource quantities. This is an accounting
outbox/cursor, not an allocation scheduler or a second execution authority.
Source receipt delivery goes directly to the independent metering service.

## Measurement and uncertainty

Use native physical instance identity and recorded start/stop/pause state.
Periodically checkpoint running intervals and flush on lifecycle changes. A
collector boot, unavailable observation, changed instance or contradictory clock
cannot silently join two running intervals. Persist the known prefix, explicitly
mark the gap unconfirmed, and start a fresh verified interval when evidence returns.
Existing machines do not receive retroactive charges from before metering began.

Source metadata and the pending receipt advance in the same local transaction.
Acknowledged deliveries are removed only after PG commit. Receipts have stable
IDs and immutable content; the receiver rejects conflicting reuse and overlapping
confirmed intervals. A source restart retries saved receipts, never a VM action.
Pending delivery is independent of the management process and the original Run.

Accounting must never prevent essential pause, destroy or confirmed physical
cleanup. If collection cannot persist, it records/announces a coverage gap when
storage recovers; it cannot invent the missing interval. Missing samples or stale
receipts are not VM-death evidence, quota release authority or a reason to replay
Tools. The single-node metadata-loss limit remains explicit.

## PG and public statements

Resource receipt and price schemas are separate from model token receipts, using
the same tenant account and pricing kinds. Keep bounded identity/specification,
interval, quality and valuation data; no commands, transcripts or Workspace bytes.
Chat deletion and Fork do not remove or duplicate actual consumption.

Versioned prices apply at their effective times, splitting an interval at a price
boundary. Integer/decimal arithmetic retains the explicit accounting precision;
never sum different currencies. A missing rate is unpriced, a gap is unconfirmed,
and neither is displayed as a known zero. Statements and export are informational.

## Acceptance

Verify duplicate/conflicting receipt delivery, overlap rejection, rate boundaries,
same-VM sharing, pause/resume, elastic expiry, unknown tails, clock discontinuity,
source/receiver/PG restart and local collection failure. A stopped management
process must not interrupt a live source's receipt delivery. Demonstrate owned
compute on the matched Cube build and clean up only after physical absence.
Consolidated artifact/live verification follows the six-slice roadmap.

Source implementation samples at 30 seconds and uses coalesced native lifecycle
hints. Intervals over 90 seconds without adequate continuous evidence are unknown,
not an execution deadline. The source uses a 65,536-record durable outbox, and
its existing metrics endpoint exposes pending deliveries and capture failures.
The receiver groups user-facing statements by resource; raw receipts remain
stream-exportable. Per-segment arithmetic truncates below 10^-12 currency; no
actual collection policy is inferred from that display/accounting precision.
Very short lifetimes lost before first observation and node-metadata loss remain
completeness limits; they are not silently reconstructed from management intent.

[Matched delivery and validation limits](../reports/runtime-accounting-20261107.md).
