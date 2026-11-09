# Matched release

ADR-0306 uses schema 215, Session topic v19, reply topic v4, Guest Tool protocol 7
and managed Cube protocol 9. The independent `session-api` and `tool-completion`
roles are part of the matched image/Helm inventory. Generate the completion TLS
Secret from the existing Cube CA before application rollout; Cubelet no longer
contains a Node completion process or platform database/object-store credentials.
The source pipeline and [delivery report](reports/runtime-decoupling-20261109.md)
record the pending verification for this change.

Drain writers and materialize every protected native replay suffix before migration.
Preserve accounts, model/provider configuration, credentials, stable machine intent
and Workspace files. After cutover, remove retired v18/v3 Kafka transports only
when no surviving native replay or pending Tool reference requires them. A new
Worker's consumption is not permission to discard an unsettled result.

Verification is consolidated and serial: native SDK contracts, PG/Kafka recovery,
Guest HTTPS retry and lifecycle history, external accounting, browser/API replacement,
and owned live Cube/Worker/VM cases. Historical procedures below describe their
original releases; obsolete Cubelet Node-adapter injection is not a current path.
No verification claim transfers automatically to this revision.

The handoff acceptance driver now selects the process boundary explicitly:
`PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_CHECK=1 PI_CLOUD_LIVE_HANDOFF_ROLE=session-api`
replaces the public API while the Worker/Projector continue; use
`PI_CLOUD_LIVE_HANDOFF_ROLE=pi-worker` for abrupt owning-Worker replacement during
one remote Bash. Both run through `scripts/run-live-cube-handoff-restart-check.mjs`.
The Worker case requires the same Run to complete and the file to contain exactly
one start/end pair. It does not redispatch the accepted shell command.

## Earlier release procedures

ADR-0305's current source cutover installs schema 214, logical environment dispatch,
ordered binding application acknowledgements, tool-host and the Kafka catalog.
Its deployment acceptance is pending in BACKLOG. The initial matched upgrade
uses the existing writer/resource drain. New ordinary tools can then use the
[tool-host component scope](COMPONENT_RELEASE.md#ordinary-tools).
Application Helm apply does not wait for readiness before activation: the operator
selects the exact new tool-host release, waits for catalog publication, then waits
for workload readiness. Distributed publication activates from inside the chosen
Pod, keeping management credentials inside the cluster. Do not use blind atomic
Helm rollback across the catalog/schema boundary; reconcile the same candidate.

Before registering templates, the operator also waits for CubeOps to report
healthy, ready nodes at the current Cubelet Pod addresses with post-start
heartbeats. Kubernetes Pod readiness alone does not establish this. The gate is
read-only and bounded; it never rewrites health or retries an uncertain create.

Prepared matched artifacts can be verified by a later operator-only commit.
Only the existing explicit release-operator/test/documentation allowlist may
differ from the ancestor artifact revision. All original input, checksum, scan
and Docker image-ID checks still run. Publication keeps the artifact source
revision and records `operatorRevision` separately. Runtime, dependency or chart
changes require a new candidate; this does not authorize rewriting old evidence.


Cube v0.7.3 preparation first dry-renders the complete pinned upstream chart
against the installed explicit values. The private candidate retains the full
manifest and stable credential additions; no Secret content is printed. New
defaults are adopted with `--reset-then-reuse-values`, while Pod networking, the
Master artifact volume and Workspace backing root are preserved. MinIO and
S3lvol stay disabled; patched TemplateCenter uses the shared filesystem backend.
Official bootstrap/runtime/CLI images have separate immutable digest and local
image-ID evidence; they are not counted as part of the fourteen custom scans.
All chart/image/input checks repeat before writer or VM drain. Native cutover
refreshes the operator CLI from the matching Ready digest-pinned CLI Pod before
updating cluster source metadata or registering templates.

ADRs 0298–0304 introduce Cube v0.7.3, the independent receipt receiver, kernel
Workspace capacity and Session/runtime separation. Use the full matched path:
the old schema-209 model-metering retention exception does not cover this change.
The operator first drains Runs/writers/terminal holders, stops application roles,
waits for existing owner leases to expire, and closes compute through Cube's
maintained allocation API. It preserves stable machine/Workspace identity and
running/paused intent, and requires confirmed physical absence on the recorded
node before clearing runtime handles. Unknown closure keeps its cleanup target.

The storage handoff runs only with API/Workers/management, file gateways and
native Cube storage consumers stopped. It installs schema 212, prepares and
checksums a quota-enabled XFS copy, and orders the persistent pool mount before
K3s. Original files are removed from the retired staging directory only after
verified cutover. The fixed root-only pool operator rechecks PG retirement and
actual Kubernetes process inventory; a plan file alone cannot authorize movement.
The private release directory retains `native-storage-maintenance.json` and the
pool's private journal retains its exact resume state. On a partial storage or
protocol change, keep writers offline and resume the recorded operation; do not
restore a mixed old/new stack or format an unrecognized existing backing file.
Running machine intent is reconciled to a fresh allocation after publication;
paused intent stays paused. This is compute maintenance, not user Workspace deletion.


ADR-0302 splits the API/Projector `session-runtime` from resource-management
`control-plane`. Deploy both entrypoints and update Web, Worker, Cube observation
and publication addresses together after the existing writer drain. The one built
Control Plane image supplies both roles and metering, with separate Helm image
values. ADR-0305 adds an independent ordinary `tool-host` role; subsequent ordinary
Tool publications replace only that role. Preserve
all allocation/Volume ownership and encrypted data capsules. Management outages
must pass the owned `PI_CLOUD_LIVE_CONTROL_PLANE_OUTAGE_CHECK=1` driver with
continued PG projection, both sequential Bash calls, authenticated history/cost
reads and SSE while management Pods are absent. Retain native recovery and bound
workflow/image/Skill/preview contracts; a source diff is not live acceptance.
The owned outage fixture keeps its Run active past the pre-outage confirmed
lease deadline, using PG time, and requires new model/compute/storage receipts
before management returns. An early-settled Run does not prove lease continuity.

The schema-209→210 retention exception belonged to the earlier model-metering
cutover and is removed. Scoped provider/catalog/Web/ordinary-tool publication
uses the maintained [component release](COMPONENT_RELEASE.md) boundaries.
Ownership, protocol and storage changes require all 14 matched custom artifacts plus the separately recorded, digest-pinned upstream chart dependencies.

ADR-0295 requires schema 209 and matched API/Web/Guest/Volume Gateway publication.
It adds Workspace-only file grants and upstream tus transport, source-owned
continuation, browser draft/receipt recovery and managed staging cleanup. Preserve
all existing originals and Workspace bytes. Run the transfer/Guest/HTTP/PG and
full browser contracts, then the owned
`PI_CLOUD_LIVE_WORKSPACE_TRANSFER_CHECK=1` driver documented in
[Workspace uploads](WORKSPACE_UPLOADS.md), retained-attachment acceptance and the
native-input recovery gate. Source checks alone do not establish publication.

The matched release and scoped Web follow-up passed these live gates on Helm 144;
[delivery and preservation](reports/workspace-file-transfers-20261105.md).

ADR-0294 requires schema 208 and matched Control Plane/Worker/Web publication.
The existing object inventory and history reference indexes now cover ordinary
uploaded originals as well as images; S3 keys and image codec remain unchanged.
Run the upload/claim, native edited-Steer, shared-Fork/GC and asset-recovery checks,
and `PI_CLOUD_BROWSER_SCOPE=attachments npm run browser:presentation:check`.
Preserve accounts, configuration and existing originals. New uploads retain their
source before Workspace placement. The authorized resumption and matched
`retained-attachments-20261104` publication passed real Luna/Cube/browser/native
recovery checks; [delivery](reports/retained-user-attachments-20261104.md).


The current Cloud Skill runtime is `cloud-skills-20261101-r5` (source `b891ab2c`,
schema 207, catalog protocol 4). It includes Worker catalog metadata, named
activation and fixed guest package export. All matched gates, real publication and
native recovery acceptance passed with original assets preserved.
[Delivery evidence](reports/cloud-skills-20261101.md).

The preceding ADR-0292 release retained schema 206 and its existing wire contracts.
Keep the owner-loss,
installed-bootstrap refusal, long-navigation Fork/prune, effective-capability,
reading-terminal, CONNECT and killed-staging regressions. The matched manifest
now includes the existing Cube egress gateway: **13 artifacts** are built/scanned.
After application startup the operator reconciles that gateway and waits for its
configuration-dependent readiness before recording successful publication.
Run owned Skill, Fork, guest-browser and native-input recovery acceptance; preserve
original assets. [Implementation and acceptance status](reports/review-repairs-20261101.md).

The same-Worker recovery correction retains schema 206 and the existing protocols.
Verify Supervisor duplicate/fencing/cancellation contracts, real PG atomic
admission/closure and the native recovery suite. After matched publication run:

```sh
PI_CLOUD_LIVE_SAME_WORKER_RECOVERY_CHECK=1 node --import tsx scripts/run-live-same-worker-recovery-check.mjs /private/same-worker.json
```

The owned fixture requires no unrelated active work. It temporarily scales the
existing Worker pool to one to remove scheduling ambiguity, requests closure
through the existing PG Outbox/Kafka path, and verifies a new lease on the same
Worker boot/container. It restores the original replica count, checks one logical
Run and a completed Tool marker written once, and physically purges only its own
Workspace. No affinity or public fault-injection endpoint is added. Also run the
maintained native-input recovery fixture and preserve original assets.

ADR-0290/0291 require schema 206 and paired API/Web/guest publication. The composer
uses one human-intake endpoint with a busy preference; remove the old Turn-targeted
steer endpoint. Skill packages use inventoried S3 objects and scoped PG metadata;
only fixed file placement runs in Cube. Run the input-boundary, Skill PG/guest and
browser checks, then `PI_CLOUD_LIVE_SKILLS_CHECK=1 node --import tsx
scripts/run-live-skill-market-check.mjs /private/skills.json` and the maintained
native-input/Cube recovery fixture. Preserve existing conversations, images,
Workspace bytes, machine intent and application startup information.

ADR-0289 requires paired Worker/provider publication (no schema change). Remove
the private Worker WebSocket envelope; GPT uses native Pi HTTP/SSE and the new
authenticated provider adapter. Drain writers and preserve original assets. Run
the provider Go race/native Pi contracts, Worker model/Stop checks, large zstd
boundaries, and the owned live model-continuation driver. Verify different Worker
processes reuse provider context and actual outbound bytes omit old images.
Provider restart/missing state must cold-open from full input; no Tool replay.

ADR-0288 requires schema 205 and paired API/Web contracts. Ordinary summaries
drop `parentSessionId`; details expose `forkSource`. Source deletion no longer
cascades through manual Forks. Preserve retained history and images while draining
writers. Run the native-family/Fork deletion and concurrency tests, peer-Fork
browser checks (`PI_CLOUD_BROWSER_SCOPE=peer-forks npm run browser:presentation:check`),
and the maintained live independent-Fork driver. It now verifies source deletion
while the Fork executes, retained images, source navigation and deleted-source UI.
Owned cleanup must explicitly delete all independent fixture conversations.

ADR-0287 requires schema 204 and a drained matched transition. Preserve existing
native bytes, Inbox/current values, images, machine intent and Workspace Volumes.
Bootstrap converts retained records, source presentation and image references
once; it must not revive pruned data on a later startup. Run native Storage and
Fork/GC contracts, the 1 GiB composed browser/Fork check below, and the independent
Fork, Cube/browser and native-input recovery fixtures after deployment. Collection
is incremental: a batch's returned body count does not mean its reference graph
is fully collected. [Measurements and delivery](reports/single-path-shared-forks-20261030.md).

ADR-0285 retains schema 203 and the existing hash/API protocols. Its private cold
import optimization changes the shared storage adapter and uses the matched path.
Run `scripts/run-fork-performance-check.mjs` inside the isolated PostgreSQL test
wrapper, the composed history fixture below, then owned live Fork/image/native
recovery checks after publication. Preserve original history and Workspace bytes.

ADR-0284 requires schema 203 and paired API/Worker/Web storage contracts. Preserve
existing bodies, images, machine intent and Workspace Volumes while draining. The
bootstrap job converts any existing Fork display prefixes once; it refuses active
legacy work. Source checks include `PI_CLOUD_FORK_RETENTION_CHECK=1 npm run
browser:history:check`. After publication run `PI_CLOUD_LIVE_FORK_CHECK=1 node
--import tsx scripts/run-live-independent-forks-check.mjs /private/fork-check`: an
owned Luna/Cube fixture must keep C and its image in an active Fork while pruning
the source to B, then continue and compact through native Pi. Ordinary native
recovery and Cube release acceptance still apply. No user conversation is a fixture.

ADR-0283 changes Worker interpretation of cancelled assistant text using Pi's
public context-only edits. It retains schema 202 and existing transport contracts.
Use the matched writer-draining procedure and preserve existing assets. After
publication, run `PI_CLOUD_LIVE_INTERRUPTED_TEXT_CHECK=1 node --import tsx
scripts/run-live-interrupted-text-check.mjs /private/interrupted-text`: actual
GPT-6 Luna and Flash streams must stop, persist their original aborted outcome,
and recall their own interrupted text through the next Run's cold native context.

ADR-0282 changes the private Runner/Model-Gateway WebSocket transport, with no
schema change (202) or native storage change. Drain writers through the maintained
matched path, retain Workspace/machine intent and image assets, and run
`scripts/run-live-model-continuation-check.mjs` with
`PI_CLOUD_LIVE_MODEL_CONTINUATION_CHECK=1`. First/cold requests must carry complete
image context; ordinary continuations must send only new input. The phone Web
picker is removed; retained Android operator acceptance uses API binding and
screen reads instead of the withdrawn controls.
Publication also applies the provider's native Codex-account WebSocket preference
through its management API. After adding accounts, rerun
`node scripts/configure-provider-websockets.mjs`; the live fixture verifies
actual provider transmission as well as local delta sizes.

ADR-0280/0281 require schema 202 and tool catalog v3 with paired Worker, Control
Plane, guest workflow and Web contracts. Preserve plans/history/Volumes during
writer draining. The scheduling controller participates in normal runtime
quiescence and must not admit work during cutover. Run the workspace-scoped
Subagent and real scheduled-input checks after publication, alongside native
input, Cube and existing Android target acceptance. [Scheduling behavior](SCHEDULES.md).

ADR-0279 originally introduced schema 201/catalog v2; the current matched
release above uses schema 202/catalog v3 with matching Worker/Control Plane/Web
contracts for external device capabilities. Drain Session writers and confirm
external execution-target admissions have closed before a protocol cutover;
retain idle device selections and device userdata. The first Android device is
published separately through [the Android operator procedure](ANDROID_EXECUTION.md),
which rejects active bindings before replacing its OnDelete Pod. Native result
ownership, ordered dispatch and unsafe-action recovery remain unchanged. Run the
real Android fixture as well as the existing coding/input recovery checks.

ADR-0278 requires schema 200 and paired API/Web snapshot version 3. Drain native
writers before index/caption backfill; preserve all native bodies/checksums and
current human-input state. Run `npm run browser:history:check` against an isolated
PG database for the 1 GiB browser/API/search/export acceptance, in addition to
ordinary presentation and live Luna/Cube checks. It is not an execution benchmark.

ADR-0277 requires a drained matched upgrade to schema 199 and the paired
Control Plane, Worker and Web command contracts. Old model header/byte-idle
environment values must not survive this release. Preserve native history,
images and Workspace Volumes; cold compact needs no VM. Source acceptance covers
native concurrent summary placement, idempotency, Stop, recovery, both provider
wait policies and the real composer. After deployment run the owned fixture:

```sh
PI_CLOUD_LIVE_COMMANDS_CHECK=1 PI_CLOUD_COMMANDS_RESTART_CHECK=1 node --import tsx scripts/run-live-conversation-commands-check.mjs /private/commands
```

It seeds synthetic context only under a quiescent Session lock, uses Luna to
compact cold and during a gated Cube Tool, verifies placement/continuation, and
optionally restarts the exact Worker carrying only its owned work. It never
modifies an existing user conversation. Physical Workspace cleanup precedes
fixture-account deletion. Run the maintained native-input and ordinary Cube
acceptance alongside this command fixture.

Compatible provider images, model catalogs and presentation-only Web changes use the [component release procedure](COMPONENT_RELEASE.md). The initial ADR-0267 schema 196 / frozen Worker model contract requires this matched procedure once. Later narrow releases retain unrelated images and running environments.

This maintained procedure replaces the temporary sequencing and fixture wrappers
used in the October 7 release. It upgrades an **already installed** self-hosted
cluster. Fresh-machine installation is a separate acceptance item. It does not
reset business data or infer physical absence from missing heartbeats.

## Prepare while the current release serves traffic

Use a clean committed checkout, installed dependencies and at least 15% free disk.
Keep the current private runtime/kubeconfig. Choose a new version and an absent
private candidate directory outside Git:

```sh
node --import tsx scripts/run-matched-release.mjs prepare /private/releases/candidate-1 candidate-1
node --import tsx scripts/run-matched-release.mjs preflight /private/releases/candidate-1
```

Preparation builds the guest without registering/pruning templates, builds the
four pinned native Cube images (including TemplateCenter), its authorization callback/egress gateway and seven application images, then runs the
existing provenance/SBOM/vulnerability gate. The application catalog goes into
the candidate directory; `runtime/k3s/images.json`, Helm and serving Pods remain
unchanged. The candidate manifest is written only after successful scans.
When guest inputs match the current template, preparation reuses/pulls its exact
registered OCI digest before scanning. Apply passes the scanned image ID to
registration and never rebuilds the guest after the scan. A reused template and
its evidence must refer to the same artifact, not merely similar source inputs.

If Trivy database download needs the host's loopback proxy, set
`PI_CLOUD_TRIVY_DOWNLOAD_NETWORK=host` and the existing `HTTP_PROXY`/`HTTPS_PROXY`
variables for preparation. Values are forwarded by environment name, not echoed
on the command line. Only database download gets that network; image scans remain
offline and the zero-fixable-HIGH/CRITICAL gate stays enforced.
For a slow Ubuntu archive route, `PI_CLOUD_CUBE_APT_MIRROR` selects an HTTPS
Ubuntu mirror for native Cube image builds (for example
`https://mirrors.ustc.edu.cn/ubuntu`). APT still verifies Ubuntu signatures and
the declared package versions. Build `NO_PROXY` is forwarded so an operator can
select a direct route for that mirror while retaining the configured upstream
proxy for other downloads. This setting does not change guest or provider egress.
Database downloads use a separate 512 MiB temporary filesystem and a 15-minute
budget; offline image scans retain their 256 MiB temporary bound. If the default
mirror is unavailable, `PI_CLOUD_TRIVY_DB_REPOSITORY` can select an
[official database location](https://trivy.dev/docs/latest/configuration/db/),
for example `public.ecr.aws/aquasecurity/trivy-db:2`. This changes the download
route, not vulnerability policy or image evidence requirements.

Preflight checks source revision/cleanliness, guest/completion input identities,
evidence checksums, catalog coverage and local image IDs against those scanned.
It is read-only: failure cannot scale a Pod, register a template, change Helm
values or replace the serving catalog. There is no mixed-version fallback.

## Drain and apply

ADR-0273 uses schema 198 and separates logical machines from physical allocations.
A desired-running machine will be recreated while its controller is active, so
planned compute retirement must first quiesce writers and stop resource
controllers. Retain desired state and Workspace identity, close the exact current
allocation, confirm physical absence on its recorded node, and retain the closed
completion before clearing its live handle. Do not use public machine Release:
it deletes the Workspace. The matched runner still requires empty native
inventory; compute-only retirement is currently an operator preparation step.
The new controller recovers retained running intent after cutover. See the
[delivery evidence](reports/resource-intent-delivery-20261023.md).

ADR-0272 requires matched managed Cube protocol 8 and the new typed
`runtime_keepalive` Session fact. Guest Tool protocol 7 and schema 197 remain.
The existing Cube authorization callback is a scanned artifact and is
replaced with the matched version before the native Cube/app cutover.
After cutover, run the existing acceptance driver with
`PI_CLOUD_LIVE_RELEASE_CHECK=1 PI_CLOUD_LIVE_ELASTIC_RETENTION=1 PI_CLOUD_RETENTION_CONTROL_OUTAGE=1`.
This uses real Luna and the actual default 15-minute idle window, verifies pure
chat renews existing compute, temporarily stops the sole Control Plane only after
checking for unfinished work, and verifies independent Cube reclamation, retained
Workspace bytes and continuation on a new VM. It writes restoration state into
the private acceptance report before stopping the service and restores it in
`finally`. If the operator itself is killed during the outage, inspect that report
and restore the recorded replica count through
`node scripts/production-kubernetes.mjs start control-plane` before retrying.
The fixture does not change the production retention duration.

For the October 24 Preview presentation amendment, the existing acceptance driver
can isolate guest interaction, screenshot Read, named answer links and actual
application navigation without repeating unrelated large-output/input fixtures:

```sh
PI_CLOUD_LIVE_RELEASE_CHECK=1 PI_CLOUD_LIVE_GUEST_BROWSER=1 PI_CLOUD_RUNTIME_CAPABILITY_SCOPE=browser node --import tsx scripts/run-live-release-acceptance.mjs
```

This scope still confirms owned physical cleanup and never skips matched artifact
checks. The default `all` scope remains the full maintained acceptance suite.
ADR-0275 extends this browser scope with `show_image`: the guest screenshot is
shown inline while activity remains collapsed, then its source file is removed.
Live/cold image identity, authenticated retained bytes and reload are checked;
ordinary model-facing Read must not display a duplicate. No generation request
is needed for this display acceptance.

For ADR-0270, preparation also verifies unprivileged guest Chromium interaction,
native screenshot Read and browser timeout cleanup. After matched cutover, run
`PI_CLOUD_LIVE_RELEASE_CHECK=1 PI_CLOUD_LIVE_GUEST_BROWSER=1 node --import tsx scripts/run-live-release-acceptance.mjs`.
The owned fixture checks actual guest clicks/canvas, screenshot vision through
the existing attachment path, a live preview link before reload, the collapsed
cold-history link and navigation to the application. This does not authorize
deleting a user's development Workspace to pass the no-VM release requirement.

Announce maintenance and stop ordinary submissions. Finish/cancel Runs through
their normal API, allow seals to project and close terminals. Dedicated compute
must be retired with its original allocation identity and confirmed absent on the
recorded node. A failed, allocation-closed, holder-free record with no runtime
identity may remain so its Workspace is preserved. Do not use public machine
Release without authorization to delete that Workspace. Let elastic warm VMs expire
through Cube (default retention: 15 minutes). Do not delete conversations
or Workspace files to pass a deployment gate. Resolve uncertain VM state through
recorded-node evidence; there is no force-ignore option. At the owner's request,
current disposable data does not require backup; [asset recovery](ASSET_RECOVERY.md)
is available on demand.

```sh
node --import tsx scripts/run-matched-release.mjs apply /private/releases/candidate-1
```

Apply repeats artifact preflight and checks that every scheduled Cube compute node
is Ready and exposes a readable/writable `/dev/kvm` to Cubelet before importing or
draining. A Ready Pod alone does not prove host virtualization survived a reboot.
This device check is read-only and detects missing devices/permissions; it does
not prove VM creation will succeed. Template creation and live acceptance retain
that responsibility. It then imports content before disruption and requires
settled Runs and a complete native inventory with no VM on any node. It stops
Web/SSH/Workers, lets the still-running Control Plane close writers/project seals,
then stops Control Plane/Volume Gateway and checks quiescence again, including
removal of all retired Tool bindings. Guest attachment protocol changes cannot
carry old descriptor bodies into the new runtime. It reconciles
native Cube through the existing declarative Helm path, registers the prepared
guest and deploys the matched application. Only successful deployment replaces
the serving image catalog.

Before native cutover, failure restores the observed replica counts. After
cutover begins, failure keeps affected application workloads offline. Inspect
the failed phase and complete the matching release, or restore a matching old
application/schema/Cube/guest set while drained. There is no automatic partial
protocol rollback. Operator-process crashes require the same inspection; automatic
operator crash recovery is not claimed. Do not run concurrent release operators
or edit source while applying a release.

On the supported WSL2/systemd host, the local loopback web profile also installs
`pi-cloud-local-web.socket` / `.service` in the operator's user systemd directory.
K3s hostPort DNAT can work inside Linux without a listening socket that Windows
localhost discovery sees. The adapter provides that socket and uses the existing
[systemd TCP proxy](https://github.com/systemd/systemd/blob/v255/man/systemd-socket-proxyd.xml)
to reach the web Service's ClusterIP. It binds only `127.0.0.1`, carries no
credentials, and preserves application placement/authentication in Kubernetes.
Unlike a temporary Pod-bound `kubectl port-forward`, its target survives Pod
replacement. Service recreation or port changes are reconciled on deployment;
unchanged units keep their active socket. The distro's existing systemd package
owns the proxy implementation/version, rather than new application relay code.
`down` removes the owned units; disabling the loopback web profile also removes
them. Non-WSL deployments do not install this adapter. The initial slice covers
the main web port, not separate administrative/provider/SSH host ports.

An existing WSL deployment can reconcile just this host entry without replacing
application images. It reads the deployed web port and Service, preserving the
stored Helm configuration and avoiding coupling to unshipped guest source edits:

```sh
node scripts/production-kubernetes.mjs local-web
```

Verify from Windows with `curl.exe --noproxy "*" http://127.0.0.1:8080/`, using the
configured web port. A Linux-only HTTP 200 does not establish Windows access.

## Acceptance and fixture restoration

ADR-0268/0269 use schema 197 and matched management/SSE contracts. The matched
upgrade preserves an installed model-catalog override. After upgrading the app,
publish the reviewed catalog containing Ultra through the existing
[catalog release](COMPONENT_RELEASE.md#catalog), preserving other model settings.
Otherwise Ultra remains unavailable even though the new runtime supports it.
Run the ordinary native-input/recovery and full Cube gates, plus the runtime
capability extension of the existing browser/Read acceptance:

```sh
PI_CLOUD_LIVE_RELEASE_CHECK=1 PI_CLOUD_LIVE_RUNTIME_CAPABILITIES=1 node --import tsx scripts/run-live-release-acceptance.mjs
```

This extension holds the existing release lock, uses only its owned tenant and
checks real guest npm/PyPI access, Max/Ultra policy, explicit delegation, native
child inheritance and compact browser navigation. During owned gated Bash calls
it changes only `controlPlane.enabledControlTools` through the same Helm chart
without hooks. On the current single-controller deployment it uses the guarded
stop-old/PG-owner-lease-closure/start-new sequence, verifies both Worker identities
and the active lease remain, then
checks preview addition/removal on later requests of the same native work. It
restores the original catalog selection and saves the private restoration receipt.

For an isolated catalog follow-up, add `PI_CLOUD_RUNTIME_CAPABILITY_SCOPE=catalog`.
Its report explicitly identifies the smaller scope and creates a warm owned
Workspace before replacement. It does not establish the skipped browser/input,
guest-registry or Max/Ultra child checks; retain their separate evidence. A Ready
Pod during rolling replacement does not prove retained VM ownership has moved;
the observed new-binding gap remains in the backlog.
No unrelated Run may be active for this check. DeepSeek is exercised with one
ordinary Tool request, without hosted-search or large-image capability probing.
Keep the deliberately enabled global guest-egress setting when cleaning fixtures.

The ADR-0191 GPT-6.1 amendment adds schema 195 for mutable Sol settings and pinned
gateway catalog metadata. Drain writers before migrating; issued Run/native
model snapshots are preserved. Validate the new UI selection and unsupported
reasoning rejection, then run real function/vision/hosted-search through the
gateway and native Cube Tools through the Worker. The existing drivers accept
`PI_CLOUD_GPT_CAPABILITY_MODEL=gpt-6.1-sol` and
`PI_CLOUD_NATIVE_TOOL_MODEL=gpt-6.1-sol`; their defaults remain GPT-6 Luna. Store
reports in the private release evidence directory and confirm fixture deletion
and physical cleanup. Gateway/Pi source versions and execution protocols do not
change in this slice.

ADR-0266 adds schema 194 for provisional attachment pins and positive object-write
completion. Verify uncertain input/edit receipts, old-writer closure, late PUT
cleanup and cancelled/corrupt source previews. ADR-0265 also requires matching
Cube patch 0012 and native stale-holder/receipt-retention tests plus owned live
KVM cleanup. Neither change revokes cleanup evidence by timeout or guessed zero.

ADR-0264 requires matched schema 193, Session topic v18 and the separated
`subagent` / `subagent_control` / `workflow` catalog. Drain and close all native
writers before replacing old development history or old supervisor requests.
Preserve accounts, model/provider configuration and credentials. Verify native
safe delegation, original Submission answers, multiple owner replacements,
lost reply/Projector replacement, target-free discovery and supervisor recovery.
Boot reply transport and guest Tool protocol remain unchanged by this slice.

ADR-0263 requires schema 192 and matched application/protocol metadata: no total
Run duration fields or fixed model-capability TTL; completed hosted content uses
native empty-text metadata carriers instead of the old non-native block. Drain
writers and remove obsolete development business history when required, preserving
accounts, model/provider configuration and credentials. Verify bounded Worker
retirement, refusal of late claims, old-token revocation, native hosted Stop/PG
reopen/handoff, native retries, phase identity and semantic/transport metrics.
Run the owned long-work/Worker-handoff acceptance across the removed 10/15-minute
thresholds, then the relevant native/browser/image/child/outage/full-Cube gates.
Physical cleanup must precede fixture ownership removal. Kafka topic, boot reply
and guest execution protocol versions are unchanged by this slice.

ADR-0262 requires schema 191 and matched application code for native read failure
recovery and explicit child resume envelopes. Kafka/guest/reply protocols remain
unchanged. Run real-PG read cancellation/termination, pool isolation, image-read
cancellation, acknowledged adoption, delayed same-Run recovery, actual named/
generic status query plans, child metadata batching and native reattachment/Stop
tests. Exercise owned 1/8/32/128-child preparation and Stop during restoration.
After the drained matched release, run native input/Stop/Worker recovery,
browser/Read/images, child handoff, Control Plane outage and full Cube acceptance.
Retain the prior image recall limitation until that live gate itself passes.

ADR-0261 repairs projection I/O bounds, duplicate-closure memory cleanup,
checkpoint proof lookup and locked Run reuse. Schema and transport versions stay
unchanged. Required source coverage includes bounded pool/cold-read/transaction
waits, lost COMMIT return, stale cleanup versus successor state, interleaved live
document proofs, SQL counts and the existing RF3/PG recovery contract. Run native
input/Stop/dual-process recovery, browser/image, child handoff, Control Plane
outage and full Cube acceptance after the drained matched release below.

ADR-0260 changes only publication I/O/lifetime behavior. Keep all current schema
and transport versions. Required source coverage includes bounded Outbox/authority/
binding SQL, startup pool cleanup, old-owner drain, reader transaction retirement,
stale-peer rediscovery and the real RF3 Session closure/recovery contract. Run the
existing native recovery, browser/images, child handoff, Control Plane replacement
and full Cube acceptance after the maintained drained matched release. Native
crash experiments are not required; controlled callbacks verify the disposal gap.

ADR-0258 requires `familyLeaseDeferrals` in private heartbeat acknowledgements;
Worker and Control Plane must be replaced together. ADR-0259 requires schema 190
for the internal `worker_failed` connection/retirement reason and scan indexes.
Execution-topic v17, reply v3, guest 7, completion 3, preview 2 and Cube management 7 remain.
Expiry acceptance includes busy-candidate pagination, live failed-Worker retirement,
PG checkout/COMMIT failures and SQL costs independent of healthy siblings. Pending
seals must retain ownership without occupying subsequent expiry admission batches.
Required source evidence includes pending local-deadline expiration, real-PG
lock isolation, pool/transport/COMMIT timeout cleanup and local-first revocation.
Run native-input/Stop/Worker and dual-process recovery, browser/images, full Cube
acceptance and the existing complete Control Plane outage check: the latter must
retain both Worker Boots and the active Session lease across management reconnect.

```sh
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_NATIVE_INPUT_CHECK=1 node --import tsx scripts/run-live-native-input-check.mjs
PI_CLOUD_LIVE_RELEASE_CHECK=1 node --import tsx scripts/run-live-release-acceptance.mjs
```

For ADR-0252's guest/preview cutover, also run the maintained real-browser and
native-receipt fault fixture on the current single-node deployment:

```sh
PI_CLOUD_LIVE_TOOL_PROGRESS_CHECK=1 PI_CLOUD_TOOL_PROGRESS_RESTART_CHECK=1 node --import tsx scripts/run-live-tool-progress-check.mjs /private/tool-preview.json
```

For ADR-0253's reply continuation, run the owned fault fixture after deploying
the matching source (real GPT-6 Luna, Cube and browser):

```sh
PI_CLOUD_LIVE_TOOL_REPLY_CHECK=1 node --import tsx scripts/run-live-tool-reply-continuation.mjs /private/tool-reply.json
```

The maintained fixture now preloads an acceptance-only wrapper in the independent
HTTPS completion Deployment, scoped to its disposable tenant and marker. It records
an ownership/restore receipt before changing the Pod template, expires the filter,
and restores the exact original image/template afterward. No production fault flag
or mutable Cubelet source is used. Missing results with a healthy return path allow
same-Run inspection; missing readiness keeps an interruptible recovery wait until
explicit Stop. Owned Cube/Worker cases check that original commands are not replayed.
Native Guest/HTTP and process-boundary contracts separately cover lost acknowledgements.

```sh
node --import tsx scripts/run-live-tool-reply-continuation.mjs --restore /private/tool-reply.json.adapter-restore.json
```

For ADR-0255's native Tool result boundaries, run the owned coordination check:

```sh
PI_CLOUD_LIVE_TOOL_SETTLEMENT_CHECK=1 node --import tsx scripts/run-live-tool-settlement-check.mjs /private/tool-settlement.json
```

It uses GPT-6 Luna and a new private tenant to verify complete structured output,
50 KiB/2,000-line overflow errors with one prior effect, and an interactive
supervisor reply. Normal API deletion and physical Workspace purge precede
removal of owned account/image fixtures. Run the ordinary native-input,
browser/Read, Tool-image recovery and full Cube checks alongside this slice.

For ADR-0256's Session publication/completion repair, required source checks
include real PG commit-return loss, terminal replay/deduplication, native Host
pre-send refusal versus unknown/post-ACK failure, I/O progress during refusal,
successive cancellation versions and the synchronized RF3 transport suite.
Live gates are native-input/Stop/dual-process recovery, browser/Read, Tool-image
cold recovery, child replies across Control Plane replacement and full Cube.
The native stream fixture requests substantive long output; early model completion
is a failed fixture, not a recovery pass. Record the deployed image/source separately
from any host-only acceptance-script revision. This slice changes no protocol version.

ADR-0257 adds required execution `generation` to public activity/path/execution
observations. Control Plane and Web must be replaced together and existing browser
pages reloaded; no old-observation decoder is retained. PG schema, Kafka/native
transport and guest versions are unchanged. The native-input recovery scenario
keeps one real SSE connection through Worker-only loss, uses the browser's actual
parser/store, and requires newer-generation activity and confirmed Cube evidence.
Its recovery follow-up holds a Tool open long enough to observe the existing path
probe. The separate real-browser presentation gate verifies DOM generation
changes. Also run slow-reader/large-snapshot contracts, normal browser acceptance,
image/child recovery and full Cube checks. All fixtures retain their ownership and
physical-purge guards.

The native-input driver checks same-Run continuation, durable edits and promotion,
retry identity, and Stop restoration against the current schema. It waits for
projected queue visibility after native ACK and for terminal seals before cleanup.
Under the current native storage contract it also checks streaming text stays out of PG, preserves the
native interrupted reply on Stop, and resumes the same Run after losing both
Worker and Projector memory. That owned fault case suspends Control Plane before
killing the Worker, kills/restarts Control Plane, and requires kubelet crash and
readiness evidence. It refuses injection while another tenant has unfinished work.

For a compatible Control Plane handoff, hold Worker/Pi/Cube and all contracts fixed
and run the owned rolling-replacement checks individually:

```sh
PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_CHECK=1 PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_MODE=rolling node --import tsx scripts/run-live-cube-handoff-restart-check.mjs /private/rolling-cube.json
PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_CHECK=1 PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_MODE=rolling PI_CLOUD_LIVE_HANDOFF_SCENARIO=child node --import tsx scripts/run-live-cube-handoff-restart-check.mjs /private/rolling-child.json
PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_CHECK=1 PI_CLOUD_LIVE_SESSION_RUNTIME_RESTART_MODE=rolling PI_CLOUD_LIVE_HANDOFF_SCENARIO=stream-image node --import tsx scripts/run-live-cube-handoff-restart-check.mjs /private/rolling-stream-image.json
```

These use the same image on overlapping old/new Control Plane Pods. They measure
replacement time, check the original Worker, native child/control replies or
image/text preservation, and wait for Workspace purge. They establish runtime
handoff behavior, not compatibility of arbitrary application/schema upgrades.
The full matched-release operator above still drains work.

For a controlled complete outage, with no unrelated active work or pre-existing
VMs, run:

```sh
PI_CLOUD_LIVE_CONTROL_PLANE_OUTAGE_CHECK=1 node --import tsx scripts/run-live-control-plane-outage-check.mjs /private/control-plane-outage.json
```

This holds Control Plane replicas at zero for at least 60 seconds, then restores
the original count. An independent watchdog also carries a guarded restore receipt.
Worker lease/Kafka progress, native VM identity, two ordered Bash calls, and a
same-key request retried across the outage are checked. Use a fresh report path;
do not discard an unrestored `.restore.json` receipt. HPA-managed deployments are
rejected. The [initial evidence](reports/control-plane-outage-20261014.md) exposed
idle Worker retirement. Schema 189's [reconnect acceptance](reports/idle-worker-reconnect-20261014.md)
requires both idle and busy Workers to keep their original containers/Boots and
register new connections, with no healthy Boot retirement. Set
`PI_CLOUD_CONTROL_PLANE_OUTAGE_MS=90000` for the longer outage case; the fixture
requires an idle Worker in addition to its busy Worker. This driver is not a
production upgrade command.

For guest working-directory changes, also run
`PI_CLOUD_LIVE_MISSING_DIRECTORY_CHECK=1 node --import tsx scripts/run-live-missing-directory-check.mjs /private/cwd-check.json`.
It uses an owned development machine and Luna to remove its selected directory,
confirm a native Tool error and same-Run reply, continue chat, and execute again
after explicit directory restoration. VM identity must remain unchanged. Cleanup
releases the machine and confirms Volume purge before deleting fixture metadata.

The targeted driver uses GPT-6 Luna and a new private tenant/Workspace. It checks
lost admission reply → Stop → returned text/image → fresh input identity/direct
vision, plus large ASCII/Unicode Read prefixes and canonical diagnostics. It
cancels remaining owned Runs, deletes its conversation/Workspace, waits for physical
purge, then removes only its own image/account fixtures. The private report
distinguishes feature acceptance from cleanup.

The native provider suite needs temporary Cube egress. Its wrapper retains the
original nullable configuration, checks revisions on installation/restoration and
audits both changes:

```sh
PI_CLOUD_LIVE_PROVIDER_CHECK=1 node --import tsx scripts/run-provider-acceptance.mjs
```

It restores configuration after suite failure and refuses to overwrite concurrent
administrator edits. If the operator process was killed, inspect settings and use
the private receipt written before enabling the fixture:

```sh
node --import tsx scripts/run-provider-acceptance.mjs --restore dist/provider-proxy-fixture.json
```

Keep reports private; never attach native Master startup logs or deployment
secrets. The owner-deferred native logging finding remains deferred. Record
source/artifact identities, outcomes and evidence scope in the release report.
A test/preflight is not a newly deployed release, and readiness is not a completed
[private pilot](PRIVATE_PILOT.md).

Current schema 190 retains the `expired` management-connection state and matching
Worker admission behavior. ADR-0249 introduced execution Topic v17; the current
matched set uses guest/Tool Worker 7, boot reply v3, completion 3, preview 2 and
Cube management 7. ADR-0258 adds the required private heartbeat deferral array.
Deploy the complete matching set while drained; do not mix incompatible publisher,
guest or private Worker schemas. Native PG storage remains unchanged and
needs no old-format decoder. Old Kafka Topics may be removed only after all their
unsealed Run floors and outstanding live replay references are closed, and old
writers and physical executions have completed the maintained cleanup checks.

The earlier schema 188 changed Session work ownership and unified Tool replies
and required a destructive matched upgrade from the previous native contract.
Drain writers and confirm physical absence before deleting obsolete development
history, root/child work, and closed Session ownership records. Preserve accounts,
model/provider configuration and credentials. Migration 188 rejects retained old
native commits or ownership records. There is no legacy ingress or child-Run mode.
The matched release still requires confirmed absence of physical VMs; the schema
marker never permits discarding cleanup ownership without its physical proof.


The reply-continuation live driver defaults to physical removal of its own
allocation, verifies same-Run continuation and a native environment-reset entry,
and checks that unrelated VMs remain present. `PI_CLOUD_REPLY_FAULT_TARGET=cubelet`
selects whole-Cubelet loss only when the node has exactly the disposable fixture
VM. It is never an implicit fallback on a shared user node.
