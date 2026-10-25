# Scoped component releases

[ADR-0267](adr/0267-scoped-releases-and-model-catalog.md) provides narrow provider,
catalog and presentation-only Web operations. Install its initial schema 196 / Worker contract with the
[matched procedure](MATCHED_RELEASE.md) first. Accounts and credentials survive.

## Ordinary Control Plane tools

[ADR-0276](adr/0276-scoped-control-plane-releases.md) adds the `control-plane`
scope after its initial matched installation. The current slice accepts ordinary
Tool code under `packages/control-plane/src/ordinary-tools/`, including its
registration module. A new tool on the existing transport needs no Worker edit.
Changes to shared protocols, dependencies, ownership, lifecycle, schema, startup
or public API contracts still require a matched release. Source classification
does not replace reviewing semantic compatibility. No browser update notification
is added.

```sh
npm run release:component -- prepare control-plane /private/releases/control-1 control-1
npm run release:component -- preflight /private/releases/control-1
npm run release:component -- apply /private/releases/control-1
```

Preparation runs Control Plane types and the ordinary Tool/catalog/dispatch/
replacement contracts, including new tests under
`packages/control-plane/test/ordinary-tools/`, then builds/scans one image. The
full rendered-manifest comparison permits only that container image to change;
the operator retains all other artifact provenance. Apply imports the image,
then uses the existing private publication listener to request quiescence. It
waits for executing control handlers and native settlement of non-replayable
effects while projection continues. Repeatable child waits and Cube commands do
not require their parent Run to finish. At a safe record boundary, subsequent
projection/recovery admission is held before PG writes and dispatch commits.

The first supported topology is one Control Plane without an HPA. The operator
stops its old Pod, waits for its existing PG sandbox-owner lease, then installs
the new image with Helm hooks disabled. Workers, provider, Cube and VM allocations
remain running. Workers reconnect; Kafka replay and Pi's next request pick up
the current catalog. New requests/Tool dispatch and SSE can pause during the
outage; keeping the existing lease requires recovery within its normal budget.

The local hold expires after 30 seconds without renewal. A busy-drain timeout
leaves the old release serving. SIGTERM repeats the quiescence check at actual
termination, protecting against a delayed scale request after hold expiry. The
existing 720-second Pod termination grace remains the outer crash boundary.
`control-plane-replacement.json` records phases before replica changes. Failure
before Helm restores the observed old template when its identity still matches.
After Helm starts, rerun the same candidate to reconcile actual state and finish
the deployment record. An unresolved Helm `pending-upgrade` still needs inspection;
there is no blind rollback or old-protocol fallback.

The live driver requires a prepared candidate containing a reviewed ordinary
Preview description change. It holds a real Luna Bash in Cube, replaces the
Control Plane, verifies unchanged unrelated Pods/Worker boots/Session lease/VM,
then unblocks the same command and checks the updated catalog within that Run:

```sh
PI_CLOUD_LIVE_CONTROL_RELEASE_CHECK=1 node --import tsx scripts/run-live-control-plane-release-check.mjs /private/releases/control-1 /private/evidence/control-1
```

It uses an owned fixture, confirms the command executed once and performs physical
VM/Volume cleanup before removing its tenant. User conversations are not used as
release probes.

## Provider image

Change the pinned provider source/catalog in `deploy/provider-gateway/Dockerfile`,
commit, and choose an absent private candidate directory and new image tag:

```sh
npm run release:component -- prepare provider /private/releases/provider-1 provider-1
npm run release:component -- preflight /private/releases/provider-1
npm run release:component -- apply /private/releases/provider-1
```

Preparation runs provider contracts, builds/scans one image and records provenance.
Render comparison permits only the CLIProxyAPI container image to change. Apply
retains Helm values, credentials, volumes, relays, Services and other workloads.
It imports one image and runs no migration hooks, writer drain or Cube operation.

The single provider replica can interrupt HTTP/SSE during replacement. Pi remains
the sole sampling retry owner. Verify native execution and interrupted-request
behavior; Pod readiness/model listing alone does not establish model usability.
No Tool replay or model substitution is introduced.

## Presentation-only Web

TSX/CSS presentation changes can replace just the Web image when the installed
API/protocol, dependencies, Caddy configuration and Helm templates are unchanged:

```sh
npm run release:component -- prepare web /private/releases/web-1 web-1
npm run release:component -- preflight /private/releases/web-1
npm run release:component -- apply /private/releases/web-1
```

The operator runs Web types/tests and browser presentation/queue checks, builds/scans
one image and allows only the Web Deployment image to differ. No migration hooks,
Worker drain or VM release runs. Existing browser connections can reconnect through
the usual SSE recovery; reload an open page to load new assets. Verify the relevant
live browser flow and retain the original backend/VM identities in release evidence.
API client, protocol, dependency, proxy or chart changes require matched release.
Hosted CI remains conservative for Web changes and uses its full gate.

## Catalog

The seed is `deploy/helm/pi-cloud-platform/files/model-catalog.json`. Helm's
`modelCatalogJson` can override it with complete validated JSON. Model names,
reasoning, modalities, hosted capabilities and budgets are data; new adapters
remain code. Credentials, URLs and executable configuration are not accepted.
Preparation sends two small paid text/function probes for each new or changed
visible model, using the installed proxy before publishing the catalog. Capability declarations alone
do not prove that upstream search or Fast actually works.

```sh
npm run release:component -- prepare catalog /private/releases/catalog-1 deploy/helm/pi-cloud-platform/files/model-catalog.json
npm run release:component -- preflight /private/releases/catalog-1
npm run release:component -- apply /private/releases/catalog-1
```

Only the catalog ConfigMap body may change. Helm hooks are disabled and no Pod
template changes. Its volume uses no subPath. Control Plane checks the file at
most once per second when read, validates a whole candidate, then swaps memory.
Invalid startup fails; invalid reload preserves the last valid catalog and
reports `reloadFailed`. Kubernetes projection is eventual; apply waits for all
serving Control Planes to report the expected digest. Refresh an open browser.

Run admission freezes complete capabilities and the catalog digest in PG. Worker
dispatch/recovery, native children and follow-up image checks use that snapshot.
Catalog updates affect future admission and never rewrite accepted work/history.
Withdrawn selections remain readable/editable; change desired settings explicitly
before retiring routes. Accepted Runs still need their original provider route.

## Records and failure handling

`runtime/k3s/deployment.json` records the full component combination. Unchanged
images retain their original source commits, immutable identities and scan
evidence; they are not rebuilt or described as freshly scanned. Full upgrades
record a new combination and preserve an installed catalog override.

Maintained operators share OS `flock`. Preflight checks source, artifact/scan
identity, installed deployment/Helm baselines and complete rendered manifests.
Application changes outside the presentation-only Web scope, chart, dependency
or protocol edits require matched preparation.
Explicitly listed operator-only tooling changes may use the narrow path after
the same contract checks; they do not replace application images.
Failed preflight never changes serving resources. Private values stay out of Git.

If apply reaches Helm but loses its final local record write, rerun the same
candidate: verify actual state, wait for convergence, then finish recording. A
different release cannot be overwritten. Helm `pending-upgrade` after process
loss requires inspection/resolution; automatic Helm-state repair is not claimed.

Rollback is an explicit compatible scoped publication. Withdraw new selections
where necessary, check that accepted work does not require the removed route,
and publish the previous compatible provider pin/catalog with a new record.
Credential-format/protocol changes require separate assessment. No automatic
mixed schema rollback or silent model alias is supported.

`npm run release:check -- provider|catalog` runs the relevant deterministic tests.
Real acceptance still covers text, native Tool round trips, affected image/search
features and interrupted requests. GPT/native drivers default to Luna; their
explicit model can be any reviewed entry in `PI_CLOUD_MODEL_CATALOG_FILE`. Retain
private reports, failed samples and fixture cleanup evidence. Full source/fault
suites remain available for Pi, ownership, storage or execution changes.

After preparing a provider candidate, the maintained live check can demonstrate
provider/catalog updates while a real Luna Bash Tool waits for an uploaded gate
file. It checks Pod/Worker/lease/VM identities, old/new Run snapshots, native
completion, catalog restoration and physical fixture cleanup:

```sh
PI_CLOUD_LIVE_COMPONENT_RELEASE_CHECK=1 node --import tsx scripts/run-live-component-release-check.mjs /private/releases/provider-1 /private/evidence/component-check-1
```

Use an absent evidence directory and exclude unrelated active Runs. The driver
publishes a temporary Luna output budget, restores the original catalog and
retains the accepted provider update. It does not promise uninterrupted SSE;
transport failure/retry is separately covered by the native Harness contracts.

Hosted CI uses the same change boundaries: provider-only edits build one image,
catalog-only edits build none, and runtime/schema/dependency/workflow changes
retain the full checks. Missing Git history selects the full path. The existing
secret scan remains independent. No new CI action or deployment service is added.

Prepared candidates may be applied by a later operator revision only when its Git
delta contains explicitly listed operator code/tests or documentation. Runtime
input fingerprints and original image/scan source identities must still match.
The operation records `operatorRevision` separately. Changes to application code,
dependencies, provider build inputs or catalog data require a fresh candidate.
