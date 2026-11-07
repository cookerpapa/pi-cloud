# Scoped component releases

[ADR-0267](adr/0267-scoped-releases-and-model-catalog.md) provides narrow provider,
catalog and presentation-only Web operations. Install its initial schema 196 / Worker contract with the
[matched procedure](MATCHED_RELEASE.md) first. Accounts and credentials survive.

## Ordinary Session runtime tools

[ADR-0302](adr/0302-session-runtime-and-resource-management.md) moves the scoped
replacement contract to `session-runtime`. Install the matched split and
`sessionRuntimeReplacement: 1` contract first. The old `control-plane` release
scope is removed. Resource management and metering are independent roles, even
though all three use the same built `pi-cloud/control-plane` artifact.

The scope accepts ordinary Tool code under
`packages/control-plane/src/ordinary-tools/`, including its registration module.
A new tool on the existing transport needs no Worker edit. Shared protocol,
dependency, ownership, lifecycle, schema, startup and public API changes require
a matched release. Source classification does not replace semantic review.

```sh
npm run release:component -- prepare session-runtime /private/releases/tools-1 tools-1
npm run release:component -- preflight /private/releases/tools-1
npm run release:component -- apply /private/releases/tools-1
```

Preparation runs the ordinary Tool/catalog/dispatch/replacement contracts and
builds/scans one Control Plane host artifact. It changes only
`images.sessionRuntime`, the `pi-cloud-session-runtime` Deployment container and
the `session-runtime` provenance record. `images.controlPlane`, `images.metering`
and their role records retain their original image identities, source revisions
and evidence. Full manifest comparison rejects changes to every other resource,
and live-role checks reject an image merely found in a different workload.

Apply requests quiescence through the Session runtime's private publication
listener. It waits for executing control handlers, bound workflow/image/Skill
operations and required native settlement while projection continues. Accepted
fixed Cube commands can remain running. Once a safe boundary is held, new
projection/recovery admission pauses before PG writes and dispatch commits.

The supported scoped topology is one Session runtime without an HPA. The
operator waits for its old Pod to exit before Helm installs the new image with
hooks disabled. It does not acquire, stop or wait on a Sandbox management lease.
Management, metering, Workers, provider, Cube and VM allocations remain running.
Kafka retains the sole Projector group and fences assignment changes. Workers
reconnect to execution membership; the next model request receives the current
catalog. New requests, dispatch and SSE can pause during this runtime replacement.
Management-only outages have their own acceptance and do not pause those paths.

The hold expires after 30 seconds without renewal. A busy-drain timeout leaves
the old release serving. SIGTERM repeats quiescence at termination, and the
existing 720-second Pod grace remains the outer crash boundary.
`session-runtime-replacement.json` records the exact role, Deployment/template,
Pod and process identities before replica changes. A pre-Helm failure restores
only that unchanged old template. After Helm starts, rerun the same candidate to
reconcile actual state and finish the deployment record. An unresolved Helm
`pending-upgrade` needs inspection; there is no blind rollback or legacy scope.

The live driver requires a prepared candidate containing a reviewed ordinary
Preview description change. It holds a real Luna Bash in Cube, replaces only
Session runtime, verifies the unchanged Worker/Session lease/VM plus management
and metering Pods/provenance, then unblocks the command and checks the new catalog
within the same Run:

```sh
PI_CLOUD_LIVE_SESSION_RUNTIME_RELEASE_CHECK=1 node --import tsx scripts/run-live-session-runtime-release-check.mjs /private/releases/tools-1 /private/evidence/tools-1
```

The owned fixture confirms one Bash execution and physical VM/Volume cleanup
before tenant removal. User conversations are not release probes.

## Provider image

After ADR-0297's matched receipt installation, the explicitly listed metering
adapter Go/patch files are provider inputs too. Corrections within the installed
context/receipt protocol can use this scope. Changed financial admission,
receipt schemas or durable ownership still require a matched decision/publication.
Existing receipt contents are not rewritten by a provider update.

[ADR-0296](adr/0296-provider-v8-and-model-accounting-boundary.md) additionally
covers the provider's v8 configuration conversion. Preparation uses the candidate
image's native configuration parser and stores a private canonical document plus
old/new hashes. The initialized configuration and management scripts have one v8
layout; the scoped gate verifies that unrelated initializer declarations did not
change. The pinned management page is part of the same private candidate.

After the new provider image is ready, its `/v8/management/config.yaml` endpoint
adopts that prepared document using `If-Match`. A lost response is checked against
the on-disk configuration ETag before any repeat. Concurrent operator changes or
unexpected bytes stop publication for reconciliation; they are never silently
overwritten. A partially damaged file requires operator recovery from the verified
private candidate before resuming. Do not downgrade a binary over v8-written state.
The publication record is completed only after configuration and the pinned
management page have been verified. Other workloads and Cube allocations remain.

ADR-0289 also permits the explicitly listed provider adapter Go/patch files when
they preserve the installed private model HTTP contract. Provider image inputs
include every local Docker COPY source. The complete manifest check additionally
allows decimal rendering of the four existing model-transport integer environment
values only when their numeric values are identical. It rejects changed limits,
unrelated environment, replicas, storage and other workloads. This supports the
scientific-notation deployment repair without rebuilding development machines;
new protocol/ownership behavior still requires a matched release.

Native model continuation also requires each Codex account's provider-owned
`websockets` metadata to be enabled. Matched and provider publication apply this
preference through the management API after readiness. After importing accounts,
run `node scripts/configure-provider-websockets.mjs`; credentials, disabled state
and non-Codex accounts are preserved. Acceptance verifies the setting and actual
provider outbound traffic, since a downstream WebSocket alone can still expand
full HTTP requests upstream. No per-request account/configuration lookup is added.

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

TSX/CSS presentation changes, plus the explicitly reviewed `session-view.ts`,
`conversation-presentation.ts`, `virtual-conversation-rows.ts`,
`composer-submission.ts` and `submission-presentation.ts` browser helpers,
can replace just the Web image when the installed
API/protocol, dependencies, Caddy configuration and Helm templates are unchanged:

```sh
npm run release:component -- prepare web /private/releases/web-1 web-1
npm run release:component -- preflight /private/releases/web-1
npm run release:component -- apply /private/releases/web-1
```

The operator runs Web types/tests and browser presentation/queue checks, builds/scans
one image and allows only the Web Deployment image to differ. The Web gate also
checks the organization Skill browser, local sharing and installation scopes. No migration hooks,
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
template changes. Its volume uses no subPath. Session runtime checks the file at
most once per second when read, validates a whole candidate, then swaps memory.
Invalid startup fails; invalid reload preserves the last valid catalog and
reports `reloadFailed`. Kubernetes projection is eventual; apply waits for all
serving Session runtimes to report the expected digest. Refresh an open browser.

Run admission freezes complete capabilities and the catalog digest in PG. Worker
dispatch/recovery, native children and follow-up image checks use that snapshot.
Catalog updates affect future admission and never rewrite accepted work/history.
Withdrawn selections remain readable/editable; change desired settings explicitly
before retiring routes. Accepted Runs still need their original provider route.

## Records and failure handling

`runtime/k3s/deployment.json` records the full role combination. Full evidence
expands the one Control Plane host artifact into independent management, Session
runtime and metering records without building or scanning it three times. Unchanged
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

`npm run release:check -- provider|catalog|session-runtime` runs the relevant deterministic tests.
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
