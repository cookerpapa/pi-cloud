# Projector/browser repair delivery

Date: 2026-10-18. Approved plan:
[ADR-0257](../adr/0257-browser-observation-and-buffer-boundaries.md).
Implementation baseline: `a57e46ee`. Source repairs are committed in `1ee690d2`;
the test-environment correction is `205e6ac0`. All required checks and live suites
pass. Matched release `browser-delivery-205e6ac0` is deployed, owned fixtures are
physically cleaned and original accounts/configuration/credentials are preserved.

## Source behavior

- Activity/path/execution frames require the existing Session fencing generation.
  Projector uses its admitted scope, with no added SQL/counter. Server and browser
  reset the entire observation bundle on a newer generation and reject older
  frames. Pending observations cannot replace newer generations with older types.
  Same-generation TTL/capacity eviction resyncs its Session readers.
- Browser observation state is a pure module separate from its React renderer.
  The real server/SSE/parser/store integration can test root and child recovery
  without importing a browser-rendering runtime into the backend. There is no
  compatibility re-export or optional-generation decoder.
- Pending formal delivery has both 1,024-event and 16 MiB encoded-byte guards.
  Measurement is lazy, once per broadcast needing queuing; direct waiting readers
  and absent subscribers need no counting. Queues retain event references and
  byte counts, not additional serialized bodies. Dequeue/reset/overflow/close
  release accounting; overflow clears disposable channels and uses existing
  replacement-snapshot recovery. In-flight values and large snapshots retain
  their normal framed delivery.
- Same-message, same-phase commentary appends compact in the recovery cache.
  Original live events, message identities, replacements, canonical renaming,
  gaps and distinct commentary messages retain their boundaries. Obsolete public
  25 ms buffering descriptions are removed from maintained guidance.
- The native-input recovery driver now holds one real SSE connection through its
  owned Worker crash and checks the browser parser/store accepts newer-generation
  activity and confirmed Cube evidence. A recovery follow-up waits 35 seconds in
  Bash so the normal bounded path probe can be observed. Other native-input,
  streaming Stop and dual-process crash assertions remain.

## Verification

51 focused tests pass, including actual server/SSE/browser-store handoff for root
and child views, late-old rejection, same-generation expiry, pending-byte release,
periodically draining sockets, healthy-reader isolation, large replacement
snapshots and commentary identity/coverage. Scoped runtime-core and web-ui
typechecks pass. Six maintained fault cases are added (294 total).
The real-browser presentation gate passes, including rendering a new generation
and ignoring a later old-generation activity frame. A bounded queued-broadcast
micro-sample measures 256 KiB events at about 0.60 ms median with either one or
four viewers; small-event medians are below 0.02 ms. This is local counting/fanout
cost, not network throughput, fleet capacity or an end-to-end latency claim.

Initial local checks caught a test-helper closing brace and cross-package test
type dependencies. The helper is corrected; the browser store is separated from
its React renderer and the integrated test lives with runtime-core. These do not
change browser JavaScript compatibility settings or execution semantics.

The first full CI run stopped in Cube's upstream binary-volume test with
`ETXTBSY` while executing a freshly written `/tmp/.../wrapper.sh`. The pinned
Go 1.26.9 source and an isolated container probe confirm `testing.TempDir()`
prefers `GOTMPDIR`; setting only `TMPDIR=/test-tmp` had left test scripts on the
overlay filesystem because compiler work used `GOTMPDIR=/tmp`. The maintained
runner now uses Go's `-exec env GOTMPDIR=/test-tmp` for the test subprocess,
keeping compilation on disk and executable test fixtures on tmpfs. The corrected
probe asserts the actual directory. No native runtime patch, retry or skipped
assertion is added. The complete CI rerun on clean source
`205e6ac0a515be64ba64e902b80cbc410d8ac4cb` passes.

Full `npm run ci` passes 1,884 workspace tests across 22 package groups, 79
acceptance helper tests, nine real isolated RF3/PG transport tests and all 294
indexed fault cases across 90 file groups. Existing environment-gated optional
tests retain their baseline skips; none was added to bypass this failure.
Dependency hardening, native Cube admission/allocation/Volume tests, builds,
types, installer, runtime policy, Helm, observability and image closure pass.
The npm security audit reports no remaining vulnerabilities. The separate
real-browser presentation and Docker build-context gates pass.
The old defect characterizations are archived at `8cd04fda`; maintained
desired-behavior regressions replace them.

## Artifacts and release

The deployed source and live test checkout are
`205e6ac0a515be64ba64e902b80cbc410d8ac4cb`. All eleven artifacts pass the existing
SBOM/provenance/vulnerability gate with zero fixable HIGH/CRITICAL findings under
its unchanged policy; unfixed findings remain reported. The guest identity is
`5d775367299e1cfc7877a2bf2544f857f4690f08`, reused as its exact registered artifact.
Completion identity is `571144ed390a79b0617c75db761b81beb7fa1eda`.
The deployed Control Plane image is
`sha256:c9abdb62002b80e0bd505d192fc07ae66adb3c8af4784b6ebe22282b23100429`.

An earlier candidate built from `1ee690d2` passed its scans but was not deployed
after the initial CI failure. The final candidate was prepared and scanned again
for `205e6ac0`; source/artifact preflight passed before apply. Docker's pre-existing
proxy configuration still points at port 12450. A temporary systemd socket proxy
forwarded it to the working host proxy only during each preparation, then was
removed and its listener confirmed absent. No daemon configuration was changed.

The public observation shape changes together across Control Plane and Web;
open browser pages reload at deployment. PG schema 189, execution topic v17,
reply v3, guest/Tool protocol 7, completion startup 3, preview 2 and Cube management
7 remain unchanged. The maintained operator checked KVM API 12, drained writers
and confirmed complete native inventory before replacing Cube/templates and
application services. All four templates and matched services are ready.

## Live acceptance

All model scenarios use GPT-6 Luna and owned fixtures; all suites pass on their
first executed attempt in this release:

| Check | Evidence |
| --- | --- |
| Same-Run Worker recovery | Actual Worker exit code 137. Execution generation 1 → 2, new activity revision 1 and confirmed Cube execution revision 5 are accepted through one SSE snapshot/connection and the browser's parser/store. No manual refresh or reconnect masks the regression. |
| Native input and Stop | Same-Run consumption, edited input, retry identity, promotion/order and Stop return pass without retaining obsolete edit bodies. |
| Interrupted text | Streaming Stop preserves the observed 202-character prefix. Losing both Worker and Control Plane preserves 161 observed characters in the same Run; both processes actually exit 137. Streaming bodies remain outside PG. |
| Real browser and Read | Lost admission reply, Stop/returned-image resend and direct vision pass. ASCII Read retains 51,200 bytes from 120,017; Unicode retains 51,196 valid UTF-8 bytes from 140,031, with canonical native truncation diagnostics. |
| Large Tool images | Images of 6,294,203, 6,294,488 and 25,128,654 bytes produce native records of 596, 596 and 597 bytes. Worker Boot replacement and overwritten Workspace source files preserve correct visual recall. |
| Child during Control Plane replacement | Same-artifact rolling replacement takes 13,146 ms. The original Worker remains, the child effect executes once and its control Tool reply is recovered through Kafka. |
| Full Cube | Pure chat activates no Cube; coding, authenticated preview, background-service survival, tenant isolation, a deterministic 1,024-file Workspace fixture, fresh-VM Volume restoration and rejection of late Tool/cancel requests to a deleted VM pass. Last-conversation deletion releases the unused elastic runtime. |

The generation recovery uses real SSE and the browser's actual parser/state
module. DOM behavior is checked separately by the real-browser presentation gate;
the Worker-fault driver does not claim an additional browser DOM recording.
During deliberate dual-process failure, a `kubectl exec` channel reported
`container not found`; kubelet termination/restart evidence verified both crashes
and the recovery assertions passed. No application failure was inferred from
that diagnostic alone.

The full Cube sample records 21 model requests, five terminal Turns, 35 native
entries and 181 projected native commits. These are bounded functional acceptance
samples, not a fleet-capacity or arbitrary cross-version upgrade guarantee.
The [full Cube report](cubesandbox-production-acceptance-latest.md) and
[JSON evidence](cubesandbox-production-acceptance-latest.json) identify the tested
checkout and deployed image.

Private evidence lives under
`deploy/production/runtime/release-evidence/browser-delivery-20261018/`, including
the failed CI sample, Go source/probes, final CI/scans/apply logs, `native-input.json`,
`browser-images.json`, `tool-images-20261018.json`, `child-20261018.json` and
`full-cube.json`. The delivery does not claim that the previously observed upstream
TLS issue is permanently resolved; this release's live suites encountered no such failure.

## Cleanup and final state

Normal APIs closed owned Sessions/Workspaces before native purge. Final checks
confirm zero Volumes, node attachment references, holders and open/non-absent
allocations. Only afterward were the owned full-Cube tenant, three exact unreferenced
image objects and three physically purged bootstrap-tenant fixture projects/
Workspaces removed. Image deletion retains hash, reference, upload and unsealed-Run
guards; native ownership/fencing records were not discarded to manufacture absence.

No test project, Workspace, Session, Run, image object/reference or upload remains.
Active writers, bindings, runtime/machine/terminal lifetimes and unpublished controls
are zero. The sole native node reports zero VMs, all 28 serving Pods are Ready,
and both Windows and WSL localhost web checks return HTTP 200. Temporary build
proxies and disposable Docker test containers are absent.

All seven original configuration fingerprints match: 32 tenants/users/API
credentials, five password credentials, 35 model profiles/credential bindings
and zero source-control credentials. Volatile API-credential last-used timestamps
are excluded from that comparison. `cleanup-20261018.json`, `after.json` and
`final-verification.json` retain the scoped cleanup and configuration evidence.
