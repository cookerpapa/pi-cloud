# Stock Cube source migration — 2026-11-11

Status: **stock Cube R3 is deployed; the capacity correction and final acceptance are in progress**.
Tracking: [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26),
[ADR-0309](../adr/0309-stock-sandbox-contract.md).
The serving installation is `stock-cube-20261111-r3`, schema 217. Old VMs were
retired with positive deletion evidence; both original development-machine
identities recovered on new native VMs with their original Workspace bytes.
Accounts, model/provider configuration, credentials and retained attachments were preserved.

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

Three isolated Docker checks passed for the actual storage plugin, and all three
were repeated successfully inside both unchanged official Master and Cubelet images: concurrent
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
Five final operator/cutover checks also passed.
Environment-gated live checks remain excluded from those counts.

All-workspace type checks, application build, Helm/distributed/self-hosted/Android
chart checks, runtime policy and maintained documentation checks passed.
The [20 targeted fault checks](stock-cube-faults-20261111.md) all passed. These source checks are distinct from the live results below and are not a fleet-scale claim.

## Release gate found in unchanged upstream artifacts

All four candidate images were built from the pinned official inputs with only
publication labels; each filesystem layer list matched its upstream base exactly.
After refreshing the vulnerability database, the existing Trivy/exception policy
produced these fixable package findings:

| Image | HIGH | CRITICAL |
| --- | ---: | ---: |
| Cube API | 15 | 1 |
| Cube Master | 19 | 1 |
| TemplateCenter | 14 | 0 |
| Cubelet | 173 | 3 |

These counts can repeat a vulnerability across packages/binaries; they are not
counts of distinct reachable attacks. [Image identities and summary](stock-cube-images-20261111.json).
Examples include Brotli, curl/OpenSSL, gRPC 1.80.0,
quic-go 0.54.0, x/net 0.58.0 and Go 1.25.14. These are scanner findings, not an
exploit experiment or a claim that each issue is reachable in this deployment.

The existing release gate initially rejected these findings. The owner subsequently
approved the four exact unchanged upstream inputs. [ADR-0310](../adr/0310-stock-cube-release-exception.md)
and `514328ef` pin the accepted references and filesystem hashes. Raw/policy scans
and SBOMs remain in the release evidence. Other image gates and all drain/fencing
checks remain enforced; no dependency overlay or global scan bypass was introduced.

Official upstream HEAD was checked as
`84d9cedf806417b8e86794b86e12138503383f70`; its
[Master dependency file](https://github.com/TencentCloud/CubeSandbox/blob/84d9cedf806417b8e86794b86e12138503383f70/CubeMaster/go.mod)
still uses the relevant older libraries. Rebuilding OS layers alone cannot fix
those pinned Go dependencies. An unmodified upstream API Dockerfile/source rebuild
was also tried; it stopped on a Rust documentation download timeout. That failed
attempt is not presented as a passing replacement artifact.

## Matched publication and live results

R3 was published with application Helm revision 160, infrastructure revision 121,
schema 217, artifact revision `fc2f3918` and operator revision `8ec802f0`.
The complete candidate contains 14 scanned images, with four exact stock-Cube
exceptions. The Guest identity remains `96e3d791e039a2d7fb60f3ea296194c122c04b5f`.

The operator drained writers and confirmed old compute deletion, preserved the
existing XFS Workspace filesystem, initialized attachment state under the cold
storage guard and removed the five private Cube SQL tables and two private
migration versions. The four official engines and application roles became Ready.
Both original machines recovered. The preservation check passed for original
account/model/credential records, both machine/Workspace identities and 394
original source/image files. This is a targeted preservation check, not a full backup.

| Check | Result |
| --- | --- |
| Real Guest restart, exact cancellation, finite expiry with an unfinished Tool | Passed; 89-second live case |
| Real Provider execution, PTY, reuse, stale-authority refusal, deletion uncertainty and cleanup | Two cases passed; four owned fixture accounts and Workspaces purged |
| User-facing unresolved-create admission, exact retry and two Ready machines | Passed within the admission fixture |
| User-facing Stop followed by release | First fixture raced resource-binding retirement; corrected wait still needs the final rerun |
| Short-lived VM capacity | Real gap fixed in `e0485697`; 37 Provider cases and type checking passed; next matched candidate pending |
| Full model/image/browser, Worker/VM recovery, production-window retention and accounting acceptance | Pending on the final candidate |

Three operator corrections were needed: use the existing Cube schema account for
retired-table cleanup, check the official `v0.7.3` version manifest, and configure
the WSL local web socket as its existing user during privileged maintenance.
All were tested and pushed. Failed partial cutovers kept application writers
stopped; they did not mix old and new protocols.

The first live fixtures also retained assumptions about private credentials,
node fields and Cubelet accounting counters. `fab3b760` switches them to retained
connection capsules, bounded positive deletion evidence and independent collector
state. Failed samples remain recorded as failures. Two disposable, never-measured
short-lifetime records required cold cleanup after physical deletion, delivery
drain and stopping the sampler. No missing quantity or price was invented.

The capacity correction reuses the already-required native detail read and
persists verified CPU/memory before Guest preparation. This avoids losing capacity
when a VM closes before the periodic sample. It adds no per-Tool query and does
not turn observed compute intervals into confirmed billable time.

## Remaining maintenance and acceptance

Four obsolete templates were deferred after the native delete API timed out.
Their ownership is retained. Inactive private node-metadata buckets are not read
by stock Cube; removing them requires a narrow cold cleanup, never deleting the
native metadata database or preserved Workspace bytes.

One preserved Workspace has an old upload-cleanup locator whose directory identity
changed. The fixed input programs work; new uploads re-register their actual
staging directory. Existing bytes were preserved rather than guessed away.

Android packaging was simplified in `fa342d61`, with 221 upstream driver files/APKs
byte-checked. Device publication remains pending and its intentionally stopped
StatefulSet stays stopped. BoxLite remains conditional in #27. The requested
131 MiB cold model upload is excluded from this acceptance.
