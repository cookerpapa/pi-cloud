# Scoped component releases

[ADR-0267](adr/0267-scoped-releases-and-model-catalog.md) provides narrow provider,
catalog and presentation-only Web operations. Install its initial schema 196 / Worker contract with the
[matched procedure](MATCHED_RELEASE.md) first. Accounts and credentials survive.

## Ordinary tools

[ADR-0305](adr/0305-execution-owned-tools-and-bindings.md) moves ordinary handlers
into `tool-host`. Install its matched schema 214 / `toolHostReplacement: 1` and
`toolCatalogPublication: 1` contracts first. Source implementation and pending
acceptance are tracked in [BACKLOG](BACKLOG.md). The old `session-runtime` tool
release scope is removed; the API and Projector remain serving during tool updates.

The scope accepts implementation/registration changes under
`packages/control-plane/src/ordinary-tools/`. Existing transport needs no Worker
edit. Protocol, dependency, ownership, lifecycle, schema, startup or public API
changes still require a matched release.

```sh
npm run release:component -- prepare tool-host /private/releases/tools-1 tools-1
npm run release:component -- preflight /private/releases/tools-1
npm run release:component -- apply /private/releases/tools-1
```

Preparation checks the ordinary Tool/catalog/dispatch/replacement contracts and
builds/scans one shared host artifact. Only `images.toolHost`, the tool-host
Deployment and its provenance record change. Management, Session runtime, metering,
Worker and Cube identities are preserved. The tool host is single-replica, without
an HPA. Its temporary drain rejects new ordinary calls and waits for accepted
handlers, without pausing Session projection, input admission or SSE. A definite
refusal becomes an unavailable result; a broken in-flight RPC becomes UNKNOWN.
Neither automatically resends an unsafe effect.

The operator records `tool-host-replacement.json`, removes the drained old Pod,
applies the new image without migration hooks, and activates its exact release
with a generation precondition. The new host publishes a complete Kafka catalog
before readiness. A lost activation reply is reconciled using the manifest;
restarting an old executable cannot select an obsolete directory. Every Worker
reconstructs the latest snapshot even without another deployment event.

The local drain expires after 30 seconds without renewal. Before Helm mutation,
failure restores only the unchanged old template. After mutation, rerun the same
candidate and reconcile actual state. Compatible rollback explicitly selects the
previous image as a new catalog generation; there is no blind schema rollback.

The live driver holds an owned Luna Bash in Cube while replacing only tool-host.
It submits a follow-up and reads the API during replacement, then checks unchanged
Worker/lease/VM and Session API/Projector identities, one Bash effect and the new
tool description within the same Run. Supply a prepared candidate with a reviewed
ordinary Preview description change:

```sh
PI_CLOUD_LIVE_TOOL_HOST_RELEASE_CHECK=1 node --import tsx scripts/run-live-tool-host-release-check.mjs /private/releases/tools-1 /private/evidence/tools-1
```

Owned fixture cleanup confirms VM/Volume absence before tenant removal. User
conversations are not release probes. The initial matched cutover is required;
this scope does not install a missing tool-host into an old runtime.

## Installed Session decoder repair

The explicit `session-decoder` scope only accepts runtime changes in
`packages/runtime-core/src/session-log-envelope.ts` to correct decoding of the
already installed envelope contract. Changes to wire meaning, producer behavior,
ownership or storage still require matched publication. Hosted CI retains its
full gate for this file; this is an operator-selected repair scope.

```sh
npm run release:component -- prepare session-decoder /private/releases/decoder-1 decoder-1
npm run release:component -- preflight /private/releases/decoder-1
npm run release:component -- apply /private/releases/decoder-1
```

It requires the installed `sessionRuntimeReplacement: 1` contract, waits for local
projection and admitted handlers to settle, then replaces only Session runtime.
API/SSE connections reconnect normally. Workers retain their PG leases; management,
tool-host and Cube stay online. It neither rewinds dispatch admission nor skips a
rejected record. The next consumer decodes from the retained Kafka position.
One role-checked replacement helper serves both this repair and ordinary Tool
publication, including unchanged-template restoration before Helm mutation.

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
runtime, metering and ordinary-tool records without four separate builds/scans. Unchanged
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

`npm run release:check -- provider|catalog|tool-host` runs the relevant deterministic tests.
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
