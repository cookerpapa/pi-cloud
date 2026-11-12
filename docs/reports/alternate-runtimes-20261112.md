# Integrated BoxLite and Android acceptance

Date: 2026-11-12. Tracking: #27 and [ADR-0313](../adr/0313-alternate-runtime-production-integration.md).

The integrated provider and device acceptance below passed on the single-host
WSL/K3s deployment. Final matched publication, restoration of Cube as the default
and restoration of the original development-machine intents are still in progress.
This report does not claim fleet-scale validation or high availability.

## Runtime boundary

Cube remains the default Linux provider. Explicit BoxLite selection uses the
unchanged official Node SDK 0.12.0 in a separate trusted node service. Workers
and the public API image do not contain that native SDK. Both Linux providers
use the same fixed Guest Tools, scoped HTTPS completion and original Kafka reply
recovery. PostgreSQL and the resource manager retain allocation, quota and idle
expiry authority. Native BoxLite AutoStop/AutoDelete remain disabled.

Workspace bytes and the storage catalog still belong to the existing persistent
Cube Volume subsystem/POSIX pool. BoxLite uses the same opaque attachment guard
and mounts only the Workspace leaf. Android application data stays in a separate
persistent Cuttlefish state directory. No Workspace archive or second result
database was added.

Android uses official Cuttlefish/Appium/UiAutomator2 artifacts. Its trusted
receiver now sends scoped HTTPS completion rather than holding Kafka, PG or S3
credentials. Pending device operations retain their original topic, offset,
deadline and cancellation target across Worker replacement. Recovery attaches
to the old wait and never repeats an accepted UI action.

The matched contracts are schema 219, Session topic v21, device executor v2 and
terminal v2. Replies v4, Guest v1, fixed Tool payload 7 and resource capsule 4
are unchanged. Public terminal ready messages no longer expose a native PID.

## Passed live checks

All model checks used GPT-6 Luna. Resource-intensive builds and acceptance ran
serially. The previously excluded 131 MiB cold-image request was not repeated.

| Area | Observed result |
| --- | --- |
| BoxLite native node | Host/Guest UID 1000 identity; file IO; paused execution refusal; resume after removing the image's old working directory; API-child restart without VM loss; confirmed deletion and exact attachment cleanup |
| Complete Linux Tools | Four real model rounds covered write/read/edit/Bash, symlink behavior, ordinary exit errors and source cropping of 1.5 MB of output |
| Public resource lifecycle | Terminal, application preview, pause/resume retaining root and Workspace files, release and physical Volume cleanup |
| Elastic expiry | The platform reclaimed an owned BoxLite allocation after its test deadline was advanced; a new allocation read the retained Workspace file |
| Worker replacement | A replacement Worker resumed the original 90-second Bash wait after 25.1 seconds; the command executed once and its original Run completed |
| Stop | Cancellation took 0.8 seconds; the foreground group stopped while completed background work, an independent group and a sibling Run in the shared VM survived |
| Browser/images | Guest Chromium interaction/canvas/screenshot, model vision, `show_image`, live/cold browser rendering, retained image after source deletion and actual preview navigation |
| VM/reply loss | The original command was called once; missing execution was settled without automatic shell replay, and environment reset was recorded |
| Android basics | All six device tools, Chinese input, three retained screenshots and browser display; no Linux VM was allocated for the device Run |
| Android Worker replacement | Original reply/deadline preserved; new Worker ownership after 23.0 seconds; no repeated device action |
| Android Stop | Native cancellation remained canonical after late delivery; no repeated device action |
| Android receiver loss | Original deadline retained; the Run timed out with unknown outcome instead of replaying the action |
| Android VM restart | Guest boot changed; an owned setting/file and the original userdata file identity survived; markers were removed |
| Android after restart | Another real six-tool/image/browser round passed after the full device restart |

The BoxLite expiry check advances only one settled test Session's PG deadline.
It is not a claim that another 30-minute wall-clock test was run. The actual
30-minute management-outage check belongs to the delivered
[platform expiry milestone](platform-idle-expiry-20261111.md).

## Failures found and fixed

- BoxLite's automatic volume ID mapping made a root default container user
  incompatible with the managed UID-1000 Workspace. The adapter now selects
  UID/GID 1000; infrastructure commands still explicitly request root. Only the
  affected Workspace root owners were repaired after physical retirement.
- Dedicated preparation removes the unused `/workspace` directory. Inheriting
  that image WORKDIR prevented the next native init from starting. The VM init
  now uses `/`, while Tools and terminals select their own cwd. The same real
  removed-directory test failed before and passed after the correction.
- The embedded SDK rejects the hosted `isPublic: false` tunnel option. Preview
  now uses its local connected stream and verifies that no URI was published.
- Standalone Session API had relied on the removed Worker gateway to register
  WebSocket support. The actual application assembly now registers the terminal
  transport and uses Nest's supported connection shutdown. Its regression test
  exercises that assembly instead of manually installing the plugin.
- Node publication now uses the maintained registry forward. Cold storage
  restoration waits directly for OnDelete node Pods instead of requesting an
  unsupported rolling-update watch.
- Android's first acceptance Run stayed queued under the host-memory admission
  guard. The failed fixture was cleaned through the queued-input API. The retry
  used a recorded temporary memory window, without relaxing the product guard.

Two original machine allocations became unconfirmed during a node replacement;
the initial cause was not established from the available logs. They were not
blindly recreated. A recorded cold maintenance boundary stopped callers,
verified empty native allocations/pre-SDK receipts/creation work, removed the
exact node container cgroup and reconciled only the exact old allocation IDs.
Fresh allocations then restored both stable machine intents. This is an
operator procedure, not a claim of automatic resolution for every uncertain
provider create.

Failed samples and their cleanup outcomes remain in private operator evidence;
they were not rewritten as successful tests. No vendor source patch was used.

## Source and artifact verification

The source work includes Android continuation `13e49ec4`, shared provider/node
integration `1d6a1215`, operator fixes `fedd955a`/`e2715405`, UID identity
`b417fa8c`, terminal assembly `e4acff45`, native tunnel `9f916e24` and init cwd
`85d08a42`. The integrated live stack used the matched core
`alternate-runtime-20261112-r2`, scoped Session API
`session-api-terminal-20261112-r1`, BoxLite node `boxlite-20261112-r5` and device
`android-20261112-r3`.

Workspace type checks, build, protocol/PG/Harness checks, RF3 transport, fixed
Guest admission, stock-Cube contract, Helm, documentation and Docker input
closure passed. The earlier 427-case fault run passed 423 cases and exposed four
stale test-title references; their current replacements and new device/Box
cases passed targeted retests. The resulting 430-case manifest was covered
cumulatively, not by a newly claimed single full run. Targeted tests were rerun
for the live-discovered fixes. New addon images passed the normal scan policy;
stock Cube retains only the exact previously authorized ADR-0310 exception.

## Limits and preservation

- BoxLite is an explicit single-node backend. The tested profile uses KVM and
  UID-1000 fixed Tools, but no host jailer or VMM seccomp filter is claimed.
  Android is the provisioned Cuttlefish target, not physical-phone support.
- No automatic provider fallback or Web phone picker was added. Backend choice
  is deployment/operator configuration. Tencent Cloud storage was not integrated
  or validated by this work.
- BoxLite compute registrations have no observation collector yet and are not
  priced. Model and persistent-capacity accounting keep their separate evidence.
- On this 20 GiB WSL host, device acceptance temporarily paused the two idle
  development machines, reduced the Worker pool to one and stopped the unused
  Cube preview proxy. Original settings are recorded for restoration. The
  Android replacement test therefore used a new Worker incarnation in the same
  Pod; the Linux handoff test had already used the normal two-Worker pool.
- Original accounts, model/provider configuration, credentials, machine intent
  and 394 recorded source/image files were preserved through the provider
  changes. Final restoration verification is pending. Android was returned to
  its original zero replicas with its userdata retained.

Maintained entry points are documented in [BoxLite execution](../BOXLITE_EXECUTION.md)
and [Android execution](../ANDROID_EXECUTION.md). They use owned fixtures and
private reports; credentials and session transcripts are not committed.
