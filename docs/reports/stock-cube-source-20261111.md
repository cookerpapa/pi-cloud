# Stock Cube source migration — 2026-11-11

Status: source implementation verified; **not deployed**.
Tracking: [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26),
[ADR-0309](../adr/0309-stock-sandbox-contract.md).
The serving installation remains `guest-runtime-20261110-r3`, schema 215.
No existing user VM, Workspace, account, provider credential or retained attachment
was removed during this source migration.

## What changes

| Former Cube extension | Current source boundary |
| --- | --- |
| Assigned allocation identity, create retry and irreversible close RPC | PG authorizes one native create send; early encrypted provider receipt; unique read-only recovery; unresolved applications remain pending |
| Recorded-node observation endpoint | Native inventory/API plus retained explicit native deletion events; an ordinary 404 or missing heartbeat is unknown |
| Volume admission/reference extensions | Supported external Volume Plugin, persistent per-Attach receipts and shared deletion admission |
| Allocation retention journal | Native timeout API and provider traffic behavior; fresh Session activity still comes through the existing Kafka writer |
| Private lifecycle history API/journal | Independent native observation collector, bounded provider attribution and opaque PG cursor |
| Managed pause/delete bridge | Ordinary provider pause/connect/delete; no diagnostics that implicitly resume a VM |
| Template/artifact cleanup patches | Native operations; failure remains pending rather than deleting ownership evidence |
| Dependency patches and Dockerfile rewrites | Pinned official artifacts, with publication metadata only and filesystem-layer parity checks |

Both patch files and their private-API consumers have been removed from the source
release path. Their historical contents remain linked at the immutable baseline
[`e1eaeb1d`](../research/cube-patch-inventory-20261110.md). The Guest application,
provider adapter, storage plugin and ordinary deployment configuration remain
PiCloud code. This is not a claim that sandbox integration requires no custom code.

Pi core, Session writer/lease ownership, Kafka-before-effect admission, Guest
operation fencing/cancellation, HTTPS completion, original reply recovery and
source output limits retain their current contracts. No Tool result ledger or
second execution scheduler is introduced.

Schema 216 replaces the private creation deadline/protocol with a single-send
permit and early receipt; current resource capsules use version 3. Schema 217
adds a provider alias to the existing accounting resource directory and an opaque
observation cursor. Session Kafka v20, replies v4, Guest executor 1 and fixed
Tool protocol 7 are unchanged; resource bindings must nevertheless drain before
this matched cutover.

## Explicit tradeoffs

- Native creation is not exactly once. PiCloud sends once, but an upstream internal
  retry can still be ambiguous. Missing or multiple lookup matches stay pending.
- A lost Attach receipt can retain an extra hold. Late or empty Detach metadata
  never releases a newer attachment. Missing hold directories are not reconstructed
  as empty during normal operation. Some failures require operator reconciliation.
- Stock CubeProxy counts routed Guest requests as activity. Periodic management
  Guest probes were removed so they cannot prevent idle expiry. Native resource
  reads remain periodic; execution uses on-demand full probes.
- Stock Cube does not provide verified continuous physical-time coverage. Sampled
  compute intervals are recorded as `provider_observation` / `unconfirmed` and are
  **unpriced**. Model and enforced Workspace-capacity metering are unchanged.
  Billable estimates require a separate explicit product contract.
- Provider-confirmed deletion follows the native provider contract. PiCloud no
  longer claims an independent kernel-level absence proof from a private node API.

## Source and isolated checks

The source changes include real-PG single-send admission, lost reply recovery,
late receipt/closure handling, preserved resource occupancy, bounded observation
collection and atomic cursor checks. The shared-VM and dedicated-machine suites
retain native family occupancy and explicit Stop semantics.

Three isolated Docker checks passed for the actual storage plugin: concurrent
initialization and killed publication; repeated Attach, late Detach, missing
metadata and closed admission; root-owned files, interrupted deletion and retained
original bytes. These checks did not replace a serving Cube engine.

The consolidated source run exposed a migration constraint referencing a
nonexistent terminal-table capsule column. It was corrected and verified on a
new database. A startup fixture lacked the now-required private capsule key; it
was corrected without relaxing production configuration. The affected 82 PG
regressions passed afterward, as did the nine migration/startup smoke tests.
The broader source run had 428 passing assertions before those repairs.
A separate 60-case focused run and the 290-case acceptance-helper suite passed.
Environment-gated live checks remain excluded from those counts.

All-workspace type checks, application build, Helm/distributed/self-hosted/Android
chart checks, runtime policy and maintained documentation checks passed.
The [20 targeted fault checks](stock-cube-faults-20261111.md) all passed. Publication evidence remains pending; none of
these results is a live stock-stack acceptance or a fleet-scale claim.

## Release gate found in unchanged upstream artifacts

Using the existing pinned Trivy and existing exception policy, the official
Cube API image produced 16 fixable HIGH/CRITICAL package findings. The official
Master image produced 20. Examples include Brotli, curl/OpenSSL, gRPC 1.80.0,
quic-go 0.54.0, x/net 0.58.0 and Go 1.25.14. These are scanner findings, not an
exploit experiment or a claim that each issue is reachable in this deployment.

The required gate in `scripts/lib/matched-release.mjs` rejects fixable HIGH/CRITICAL
findings. The four formerly patched native roles remain inside that gate. No
exception, scan bypass, dependency overlay or relabeling as exempt upstream
infrastructure was introduced.

Official upstream HEAD was checked as
`84d9cedf806417b8e86794b86e12138503383f70`; its
[Master dependency file](https://github.com/TencentCloud/CubeSandbox/blob/84d9cedf806417b8e86794b86e12138503383f70/CubeMaster/go.mod)
still uses the relevant older libraries. Rebuilding OS layers alone cannot fix
those pinned Go dependencies. An unmodified upstream API Dockerfile/source rebuild
was also tried; it stopped on a Rust documentation download timeout. That failed
attempt is not presented as a passing replacement artifact.

Strictly unchanged upstream inputs and the current release gate therefore do not
yet produce an acceptable matched release. A fixed upstream input or an explicitly
reviewed change to the selected dependency/release policy is required. Existing
services remain on the previous release while this is unresolved.

## Cutover and remaining acceptance

Before any replacement, drain writers, settle resource applications, confirm old
compute deletion and finish pending Workspace deletion. Preserve stable machine
intent, accounts, configuration, credentials, retained images and Workspace bytes.
Initialize the new attachment directory only under the existing cold storage guard,
against each frozen Volume generation. A later native deployment must reject
missing attachment state rather than repeat that one-time initialization.

After old native writers disappear, the operator removes only the five retired
`t_pi_cloud_*` extension tables and their two exact migration/fingerprint versions.
It does not remove upstream Volume/template tables. Existing live extension data
has not been touched; final cold node-metadata cleanup remains part of cutover.

The complete stock-image cutover, real Guest/Worker/VM recovery, native expiry,
images and accounting acceptance remain pending. Android packaging was simplified
in `fa342d61`, with 221 upstream driver files/APKs byte-checked; device publication
remains pending and its intentionally stopped StatefulSet stays stopped. BoxLite
adoption remains conditional on the validated stock-provider boundary in #27.
