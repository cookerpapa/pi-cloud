# Matched and planned release

Use the maintained operator from a clean, committed checkout. It plans artifacts,
serving roles and physical maintenance separately under
[ADR-0320](adr/0320-release-plans-and-artifact-reuse.md). Preparation does not change
the serving catalog. All builds and native/live checks on the WSL host run serially.

The current verified record is `decoupled-metadata-20261113`, schema 222, Session
topic v21, reply topic v4, resource capsule 4, provider contract 1, Guest executor
1, fixed Tool payload 7, Android executor 2 and public terminal 2. Core, Tool-host
and Web artifacts intentionally retain their own source revisions. The
[delivery report](reports/decoupling-delivery-20261113.md) records the cold storage
adoption, actual component-only rollouts and zero-restart metadata publication.

## Prepare and inspect

```sh
node --import tsx scripts/run-matched-release.mjs prepare /private/releases/candidate-1 candidate-1
node --import tsx scripts/run-matched-release.mjs preflight /private/releases/candidate-1
```

The private `release-plan.json` records the baseline, changed source, actual Docker
COPY inputs, artifact identities, original provenance, serving role catalog,
contract/maintenance reasons and required gates. Read the printed build/reuse and
role plan before applying. Do not rebuild a serving tag in place.

An isolated supported Web, Session API, ordinary Tool-host, Session decoder or
retention, Worker bootstrap or provider change delegates to the existing
[component operator](COMPONENT_RELEASE.md). CI uses the same reviewed source
allowlist. Unclassified or shared changes remain on matched verification.
Explicit model catalog publication still uses its supplied catalog file; a release
must not replace the user's model configuration with a repository seed.

Unchanged artifacts retain their exact reference, image ID and original source
revision. A shared host image does not erase independently published role versions.
Only changed or missing node-cache images are imported. Stock Cube images can keep
their prior version tags; no metadata-only rebuild is needed to make them look new.

Evidence records scanner/policy and vulnerability-database identities. A scan can
be reused only when all of those and the immutable image match. Its original scan
time and checksum-covered reports remain visible. Otherwise scan the retained
image again. Old evidence without database identity requires a fresh scan once.
The four exact official Cube images retain the owner's
[fixed exception](adr/0310-stock-cube-release-exception.md); no general scan bypass
or hidden source/dependency patch is allowed.

A pure root Chart version change is validated against the complete installed
manifest. Only the top-level informational chart label may differ. It uses
`--no-hooks`, builds no image and verifies unchanged Pod UIDs. Documentation-only
changes with unchanged artifact inputs produce a no-op candidate.

## Apply and recover

```sh
node --import tsx scripts/run-matched-release.mjs apply /private/releases/candidate-1
```

The matched path still settles Runs, pending seals/replay suffixes, uploads and
terminal holders before stopping writers. Known component scopes avoid this
whole-application drain through their verified replacement contract. An unknown
combined application change remains conservative; it is not automatically a
zero-interruption release.

Native compute/storage retirement is conditional on the recorded Guest, native,
storage or ownership contract change. A compatible application cutover preserves
native compute and Workspace files. Physical maintenance keeps stable machine
intent, original cleanup targets, exact attachment holds and quota reservations
until positive absence is confirmed. Missing heartbeat, route or inventory rows
are not that proof. Never retry an uncertain native create or arbitrary shell.

`apply-started.json` binds an interrupted publication to the exact baseline and
plan. Forward repair accepts only that candidate's baseline/planned image
references. It must still satisfy the drain and physical guards. An unrelated
image or another publication is refused. After schema/physical cutover, a failed
application start remains offline for repair; there is no blind old/new rollback.
The final deployment manifest is recorded only after the maintained final steps.
Reapplying a completed candidate verifies it without repeating resource retirement.

Preserve accounts, model/provider configuration, credentials, conversation
attachments, Workspace bytes and Android userdata. Running machine intent recovers
to a new allocation only after confirmed old absence; deliberate pause stays
paused. This is compute maintenance, not user Workspace deletion.

## Workspace persistence handoff

[ADR-0318](adr/0318-workspace-persistence-and-native-mounts.md) required one cold
adoption, completed in this deployment. A deployment that still needs that
ownership handoff must stop API/Workers/management, uploads, file gateways and actual native
storage consumers using the existing recorded guard. Verify the owned XFS mount,
its identity and original generations; do not format or create an empty substitute
for known missing data. The existing root storage helper adopts metadata without
copying user files. PG stores pool/generation/initialization state.

An old cleared quota-pending flag does not prove that storage was initialized:
unused Workspaces can have deferred quota reconciliation. Adoption distinguishes
those using the helper's durable knowledge and indexed prior resource/file use.
Missing known or previously used bytes stay unresolved.

After the new supported mount hook is actually installed and hash-checked,
retire old Cube volume registrations through ordinary APIs and confirm metadata
absence. The new Destroy hook does not delete Workspace bytes. Exact holds and
physical quiescence remain mandatory. Completed private extension-table removal
and legacy holder initialization are no longer part of ordinary publication.

The pool's private journal and `native-storage-maintenance.json` retain interrupted
cold-operation state. Only the existing bound proof can resume an unfinished
filesystem handoff after reboot. Do not discard ownership records to make a retry
appear empty.

## Acceptance

Run the appropriate source, real PG, RF3 transport, native Guest, mount/storage,
image closure and scan gates in [EVALUATION](EVALUATION.md). Then exercise the
actual affected flows, including cancellation, original-reply Worker recovery,
management outage, images/attachments, Skill lifecycle, backend registration and
physical cleanup. Test resources use disposable owned tenants; original user
conversations are not fault fixtures.

```sh
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_NATIVE_INPUT_CHECK=1 node --import tsx scripts/run-live-native-input-check.mjs
PI_CLOUD_LIVE_RELEASE_CHECK=1 node --import tsx scripts/run-live-release-acceptance.mjs
```

Use the existing handoff driver with `PI_CLOUD_LIVE_HANDOFF_ROLE=session-api` or
`pi-worker`; require the same logical Run and one original Tool effect. Diagnostic
probes never enter model history or authorize deletion. The 30-minute retention
fixture and management-outage variant remain required when expiry behavior changes;
advancing an owned deadline is not an elapsed-time test. No 131 MiB cold-provider
request is required by this release.

Publish the optional [BoxLite node](BOXLITE_EXECUTION.md) separately from matching
host/Guest artifacts, then register it through the PG directory. Keep device tests
serial. Confirm owned resource/Workspace purge before deleting fixture ownership.
Keep private reports private; publish source/artifact identities, outcomes and
material limits in the release report. Historical cutovers remain in the indexed
ADRs and delivery reports, not as competing instructions in this procedure.
