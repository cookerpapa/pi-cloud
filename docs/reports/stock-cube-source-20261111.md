# Stock Cube deployment — 2026-11-11

Status: `stock-cube-20261111-r5` is deployed; maintained live acceptance passed.
Tracking: [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26),
[ADR-0309](../adr/0309-stock-sandbox-contract.md),
[ADR-0310](../adr/0310-stock-cube-release-exception.md).

## Delivered boundary

Cube API, Master, TemplateCenter and Cubelet use digest-pinned official v0.7.3
images. Publication adds OCI labels only: every filesystem layer is checked
against its official input. Both former Cube patch files, dependency rewrites
and private allocation/history API consumers are removed. Other native chart
images are included in the pinned upstream-image inventory.

Pi Managed Agents still owns the Guest application, sandbox adapter, supported
Volume Plugin and deployment configuration. The Volume Plugin is an executable
invoked through Cube's normal storage interface: it mounts a persistent Workspace
into a VM, retains an opaque receipt per attachment, and coordinates deletion
with the Volume Gateway. Retiring compute alone does not erase that Workspace; explicit Workspace release
is a separate lifecycle operation. Missing
or mismatched attachment receipts remain uncertain rather than permitting deletion.
This external integration is not a Cube source patch.

| Former Cube extension | Maintained replacement |
| --- | --- |
| Assigned allocation identity, create retry and irreversible close RPC | One PG-authorized native create send; encrypted early receipt; unique read-only recovery; unresolved applications remain pending |
| Recorded-node observation endpoint | Native inventory/status and retained explicit native deletion evidence; ordinary missing inventory is unknown |
| Private Volume references and admission | Supported external Volume Plugin, exact attachment receipts and shared deletion admission |
| Allocation retention journal | Native timeout API and provider traffic semantics; fresh resource use arrives through the existing Session writer |
| Private lifecycle history and compute receipts | Independent observation collector, bounded provider attribution and atomic opaque PG cursor |
| Custom connection receipt lookup | Retained encrypted connection capsules, scoped to the original native identity |
| Native execution admission, cancellation and completion | Fixed Guest program, ordinary process API, scoped HTTPS completion and protected original reply references |

The [original patch inventory](../research/cube-patch-inventory-20261110.md) links
the immutable old baseline. Pi core is unchanged. No Tool result ledger, second
scheduler, unsafe shell replay or compatibility runtime was introduced.

## Published artifacts and preservation

- Final matched artifact and operator revision: `e1cb8c913c6746c0419ff79673651fc37e7406ee`.
- Application Helm revision 162; infrastructure 123; native Cube 221.
- PG schema 217; Session Kafka v20; reply protocol v4; Guest executor 1; fixed Tool protocol 7.
- Guest identity: `96e3d791e039a2d7fb60f3ea296194c122c04b5f`.
- Fourteen scanned images, complete raw/policy findings, SBOMs and checksums.
- Four exact official-image exceptions under ADR-0310; all other release gates remain enforced.

The operator drained writers, confirmed old compute deletion, verified the
existing XFS Workspace filesystem and restored both original machines on new
native VMs. Original account/model/credential records, both machine/Workspace
identities and 394 original source/image files passed the preservation check.
This is a targeted preservation check, not a full backup or a claim to hash every
large file. The Workspace byte authority remained the same persistent filesystem.

Five private Cube SQL tables and their two exact migration versions were removed
after old writers disappeared. Partial cutover failures kept application writers
stopped until repair; no mixed-protocol rollback was performed.

## Verification

| Check | Result and scope |
| --- | --- |
| Native Guest restart, exact cancellation and expiry during unfinished work | Passed on R3; unchanged Guest and native filesystem inputs retained through R5 |
| Native Provider execution, PTY, reuse, stale authority, deletion uncertainty and cleanup | Two real cases passed on R3; four owned accounts/Workspaces cleaned |
| Creation admission and Stop/release | R4 passed unresolved-create restrictions, exact retry, two Ready machines, active-work rejection, native/binding retirement and preservation of the other machine |
| Browser inputs and images | R4 passed lost-ACK/Stop/returned-input/image resend, direct vision, Chromium screenshot, inline image and named preview link checks |
| Source output bounds | R4 Read returned 51,200/51,196 bytes from 120,017/140,031-byte ASCII/Unicode sources, preserving UTF-8 and canonical diagnostics |
| Owned VM failure | R4 resumed the original Run with one original Tool call and an environment-reset record; fixture cleanup passed |
| Worker failure with original Tool still running | R5 replaced the Worker in 26.8 seconds; the original command was still pending at reacquisition and completed afterward |
| Reachable old inventory retirement | R5 explicitly invoked the old retirement path while that command was pending; cancellation remained false, the original result arrived and the file recorded exactly one start and finish |
| Real resource accounting | R5 passed 1 GiB kernel enforcement, growth to 2 GiB, two Sessions sharing one allocation, paused compute with retained storage, stale-cursor refusal and authenticated statements |
| Receipt deduplication | R5 kept two stored facts after three Workspace deliveries and two stale observation-page attempts; sixteen receipts exported |
| Actual 30-minute idle policy | R5 passed the actual 1,800,000 ms policy: activity renewed a pending Tool, native deletion was confirmed, and a new VM read the retained file with an environment-reset notice |

All completed live fixtures confirmed their owned physical cleanup. The
131 MiB cold model request was excluded as requested. New models were exercised
with GPT-6 Luna. Tests ran serially; these are single-host results, not fleet-scale
benchmarks or exactly-once guarantees for arbitrary commands.

The source migration also passed all-workspace type checks and application build,
Helm/runtime-policy/docs checks, corrected migration/startup checks, the affected
82 PG regressions, acceptance-helper checks and [20 targeted faults](stock-cube-faults-20261111.md).
Later fixes passed 37 Provider cases, 79 controller/API cases, affected type checks,
13 cleanup-barrier cases and [three Worker-retirement faults](stock-worker-retirement-20261111.md).
These suites overlap earlier coverage; their counts are not summed as unique tests.

## Failures found and repaired

The initial operator still assumed a usable MySQL root login and a patched Cube
version string. It now uses the existing schema account and official version
manifest. Privileged WSL maintenance configures the localhost web socket under
its existing runtime owner. These corrections preserve credentials, image checks
and Workspace guards.

Some live fixtures still expected private node/credential APIs and Cubelet
accounting counters. They now use retained connection data, bounded native
positive-deletion evidence and the independent collector's committed state.
The accounting fixture uses the current observation cursor before testing that
an obsolete collector cannot commit a page. Stock observations are not replayable
raw provider history.

A real short-lifetime gap was fixed: native create replies can omit CPU/memory.
The same early receipt is enriched from the already-required native detail read
before Guest preparation. No extra per-Tool query, guessed quantity or fabricated
physical start time is added. Two disposable unmeasured fixture records required
explicit cold cleanup after physical deletion, receipt drain and stopping the
sampler; the failed acceptance report was retained.

A Worker-loss sample recovered its Run but returned `Command aborted`. Two later
passes did not explain that failure. A bounded read of the failed Session's Kafka
interval found cancellation targets before a recoverable seal. The reachable
old-management inventory path implicitly cancelled accepted Guest work; the
unreachable path did not. Both regression tests failed before the fix. Routing
retirement now preserves accepted work, while explicit chat Stop retains its
ordered cancellation. The final live test forces this reachable path and checks
the original protected binding, Tool result and execution count.

Failed samples remain recorded as failures in private release evidence. Reports
committed to the repository contain summaries, not user transcripts or credentials.

## Deliberate limits and remaining maintenance

- Stock Cube cannot prove continuous physical-time coverage. Sampled compute
  intervals are **unconfirmed and unpriced**; model and verified Workspace-capacity
  accounting retain their own evidence. Billable estimates need a separate decision.
- Official-image dependency findings remain present under the explicitly approved
  four-input exception. This is not remediation or a finding that every vulnerability
  is unreachable. [Original scan identities and summary](stock-cube-images-20261111.json).
- Native create is not exactly once. Missing/ambiguous results and lost attachment
  acknowledgements may require operator reconciliation; uncertain ownership is retained.
- Four obsolete templates were deferred after native delete timeouts. Inactive
  private node-metadata buckets are not read by stock Cube; removing them requires
  narrow cold cleanup, not deletion of the native metadata database.
- One preserved Workspace has a stale upload-cleanup locator. Current input programs
  work and new uploads re-register their staging directory; old bytes were preserved.
- Android packaging was source-audited but its intentionally stopped deployment
  remains stopped. BoxLite is not enabled. Portability work remains in [#27](https://github.com/cookerpapa/pi-managed-agents/issues/27).
