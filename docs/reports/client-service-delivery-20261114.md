# Shared clients, local execution and service-minute delivery

Date: 2026-11-14. Issues: [#38](https://github.com/cookerpapa/pi-managed-agents/issues/38), [#39](https://github.com/cookerpapa/pi-managed-agents/issues/39).

## Delivered behavior

Web and Node consumers share the Session HTTP/SSE/state/input implementation.
The server still joins canonical history with its live suffix; clients do not
read PG or Kafka. Closing a chat reader does not stop a Run or its executor.
An explicit Linux connector can execute fixed file/shell tools in a selected
project while Pi remains in the cloud Worker. Outbound dispatch uses a separate
device-link gateway; results use the existing scoped HTTPS completion path.
Local files are not synchronized to a cloud Workspace. User-owned devices have
no managed compute allocation, idle deletion or compute charge.

Resource management records provider-neutral platform service periods. Independent
metering settles completed eligible minutes, carries partial progress between
batches and waives the final remainder. Known interruption/observation gaps remain
unpriced. Accepted pause/release or effective expiry cuts billing before eventual
physical cleanup. Cube, BoxLite and explicitly enrolled managed Android share
this contract. Ordinary registered Android and local Linux devices remain BYO.
No production prices or payment collection were enabled.

Reclamation logs distinguish accepted close, actual deletion dispatch and positive
deletion confirmation. Physical stop occurrence remains null without trustworthy
provider evidence. Accounting never authorizes dispatch, renewal, deletion or
quota release. See [ADR-0321](../adr/0321-shared-session-client.md), [ADR-0322](../adr/0322-outbound-local-execution.md) and [ADR-0323](../adr/0323-platform-service-minutes.md).

## Publication and repairs

Core publication is `local-image-reply-20261113`, schema 224, Session topic v21,
reply topic v4 and executor protocol 2. The shared Control Plane artifact is from
`e0d294c7`; unchanged role images retain their original verified revisions.
The fixed Guest is `59e7e34c53cdfa07e969107a496f14c13e8bc710`.
The separate device gateway is `client-device-20261113-r1` (`d0b8219f`).
BoxLite is `client-box-20261114-r2` (`72400e16`). Android is
`client-android-20261114-r1` (also `72400e16`).
Private manifests retain immutable image IDs, source and scan provenance.

Live checks exposed and repaired two real integration gaps:

- Matched Guest publication updated local template configuration but did not
  update the registered primary backend. Recovery then selected an old Guest,
  which correctly failed isolation validation. ADR-0324 publishes the verified
  deployment-owned template directory before recovery. Cold cleanup can retire
  a confirmed early Cube creation while retaining its original receipt and
  Workspace ownership; uncertain creation is still not replayed or forgotten.
- Local image reads reached the completion adapter but were missing from its
  allowed image-tool set. `local_read` now uses the retained-image path with the
  same one-image bound; model-based image recognition passed afterward.

Build-only changes forward NO_PROXY and offer an explicit direct-download mode
without rewriting serving proxy configuration. A private public-registry Docker
configuration avoided a broken Windows credential helper; original credentials
were not changed. BoxLite now installs only its pinned native SDK in that stage
and has a narrow Docker context. The published image preserves the accepted SDK,
adapter source, Node and OS-package identities. Main/Guest artifact inputs were
unchanged by that build optimization.

## Verification

Heavy checks and provider acceptance ran serially on the existing WSL host.

| Area | Actual evidence |
| --- | --- |
| Source | 2,576 package tests passed in the broad run; one stale schema-count assertion was corrected and its 19-test group passed. 314 helper checks, 434 fault cases and 11 RF3/PG transport checks passed. |
| Additional fixes | 46 template/admission/adapter checks, completion package 18 tests, proxy helper 6 tests and Box release/context checks passed. |
| Static/build/browser | Workspace types, role closures, Docker contexts, Helm, installation/policy/native/docs checks, dependency audit and presentation/queue/Skill browser checks passed. |
| Local Linux | Real Luna write/edit/read/Bash and PNG recognition; two simultaneous clients, closing one reader, owned Worker replacement and original pending reply recovery. The Bash marker appeared once, with no cloud VM or compute charge. |
| Cube | Real Luna, 1 GiB kernel quota rejection, growth to 2 GiB, two Sessions sharing one VM, service minutes before any Run, pause stopping compute while retained storage continues, statement/export/replay and physical cleanup. |
| BoxLite | Terminal/preview, background server after terminal close, real service-minute receipt, pause/resume, public upload, owned expiry and new-allocation Workspace retention, confirmed cleanup. |
| Android | Real Luna six-tool execution and Chinese input, three retained/browser-rendered screenshots, resource-page binding, Worker replacement, Stop/late-result settlement and receiver loss without replay. Real service-minute receipts, withdrawal, and VM-restart file/settings/userdata retention passed. |

The first Cube accounting sample used a 120-second receipt wait; combined passive
sampling and collector alignment needed about 157 seconds. The acceptance wait
is now 240 seconds with diagnostics; production timing was not changed.
BoxLite's expiry fixture advances only its own deadline, not production policy;
the earlier real 30-minute expiry experiment remains separate evidence.

Android produced two closed service periods around its deliberate receiver loss;
the unobserved gap was not filled, and withdrawal left no open period.

Actual Cube and Box deletion logs recorded confirmed cleanup after dispatch,
with no invented physical-stop timestamp. These small samples are not latency
or availability guarantees. Pricing/restart/gap/rounding behavior is covered by
source/PG contract tests; no provider billing API or per-second probe is required.

Private reports include `local-live-r3.json`, `cube-accounting-r2.json`,
`box-live-r1.json`, `box-runtime-equivalence.json`, `reclamation-live-evidence.json`,
`android-live-r1.json`, `android-restart-r1.json` and `android-service-periods.json` under `.cache/client-service-20261113/`.
Raw model history, credentials, user files and private reports are not committed.

## Preservation and limits

Both original development machines retain their Workspace identities
and running intent. Account/configuration hashes and 393 original source/image
files were unchanged. The sole removed record was the owner-approved stale
locator for an independently verified empty upload area. Android kept the original
userdata file identity, a written setting and a synced file across VM restart.
Owned fixtures and their credentials were cleaned up, managed Android enrollment
was withdrawn, and both optional nodes were returned to zero replicas. Temporary
2 GiB Worker limits used to admit work on this constrained host were restored.

The maintained template-retention helper was retried after publication. Four
obsolete Cube templates remain deferred because the native deletion call times
out; ownership/cleanup records were not discarded. Selected current templates
remain READY. This is separate from the owned acceptance fixtures, whose physical
cleanup is verified, and remains an operational follow-up.

This is a Linux operator integration, not a packaged desktop/mobile product or
Windows/macOS executor. The local Bubblewrap namespace is not KVM-equivalent.
The single gateway/private-network deployment does not establish Internet
reachability or fleet HA. No local Harness, automatic file sync, sandbox fallback,
WSL memory adjustment or BoxLite isolation change was introduced.

Service minutes represent the agreed available platform service, not measured
CPU utilization or second-perfect VM uptime. Observation gaps remain unpriced;
physical-stop occurrence may remain unknown. Large managed Android fleet sampling,
hosted/multi-node storage and stronger BoxLite isolation remain separate work.
Actual tariffs/payment collection remain disabled. The deferred 131 MiB cold-model
request was not repeated.
