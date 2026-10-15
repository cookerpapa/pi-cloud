# Matched release procedure

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
three pinned native Cube images and seven application images, then runs the
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

Preflight checks source revision/cleanliness, guest/completion input identities,
evidence checksums, catalog coverage and local image IDs against those scanned.
It is read-only: failure cannot scale a Pod, register a template, change Helm
values or replace the serving catalog. There is no mixed-version fallback.

## Drain and apply

Announce maintenance and stop ordinary submissions. Finish/cancel Runs through
their normal API, allow seals to project, close terminals and release development
machines through their existing lifecycle controls. Let elastic warm VMs expire
through the Control Plane (default warm TTL: 15 minutes). Do not delete conversations
or Workspace files to pass a deployment gate. Resolve uncertain VM state through
recorded-node evidence; there is no force-ignore option. At the owner's request,
current disposable data does not require backup; [asset recovery](ASSET_RECOVERY.md)
is available on demand.

```sh
node --import tsx scripts/run-matched-release.mjs apply /private/releases/candidate-1
```

Apply repeats artifact preflight and imports content before disruption. It requires
settled Runs and a complete native inventory with no VM on any node. It stops
Web/SSH/Workers, lets the still-running Control Plane close writers/project seals,
then stops Control Plane/Volume Gateway and checks quiescence again. It reconciles
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

## Acceptance and fixture restoration

```sh
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_NATIVE_INPUT_CHECK=1 node --import tsx scripts/run-live-native-input-check.mjs
PI_CLOUD_LIVE_RELEASE_CHECK=1 node --import tsx scripts/run-live-release-acceptance.mjs
```

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
PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_MODE=rolling node --import tsx scripts/run-live-cube-handoff-restart-check.mjs /private/rolling-cube.json
PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_MODE=rolling PI_CLOUD_LIVE_HANDOFF_SCENARIO=child node --import tsx scripts/run-live-cube-handoff-restart-check.mjs /private/rolling-child.json
PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_MODE=rolling PI_CLOUD_LIVE_HANDOFF_SCENARIO=stream-image node --import tsx scripts/run-live-cube-handoff-restart-check.mjs /private/rolling-stream-image.json
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

Current schema 189 retains the `expired` management-connection state and matching
Worker admission behavior. ADR-0249 changes the execution Topic to v17 and the
guest/Tool Worker protocol to 5, retaining boot reply v3 and Cube management 7.
Deploy the complete matching set while drained; do not roll v16/v17 publishers
or protocol-4/protocol-5 guests together. Native PG storage remains unchanged and
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
