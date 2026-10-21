# ADR-0267: component releases and a runtime model catalog

Status: approved for implementation, 2026-10-21. The owner requested both phases
of the scoped-release proposal together. Delivery and live acceptance remain pending.

## Decision

Keep Helm/Kubernetes as deployment authority and PostgreSQL as Run authority.
Add bounded provider and catalog release operations to the maintained release
tooling. Full application/schema/transport changes retain the drained matched
upgrade. No new release service, configuration database, scheduler or proxy is
introduced. Helm already supports retained values and declarative updates;
the existing immutable-image and rendered-manifest checks provide the bounded
integration. See [Helm 3 upgrade](https://v3.helm.sh/docs/helm/helm_upgrade/) and
[ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/).

Each deployment record describes its complete component combination, with exact
image IDs/digests, source revision and evidence references per component. Reusing
an artifact retains its original provenance. Provider-only preparation builds
and scans only that artifact. Apply compares the recorded baseline and rendered
Helm resources, permitting only the provider image to change. It neither invokes
database migration/Cube reconciliation nor drains application writers. Catalog
publication permits only the model ConfigMap contents to change. Both operations
keep accounts, secrets, routes, PVCs, Workspace bytes and other workloads intact.
Unclassified changes cannot use these narrower paths. Release operators remain
serialized; a partial failure is inspected against actual Helm state before retry.

The reviewed model catalog becomes a versioned JSON deployment input. It declares
only supported provider adapters, model identities, public defaults, reasoning,
modalities, hosted capabilities and context/output budgets. It contains no code,
credentials or arbitrary endpoints. One Control Plane loader validates a complete
candidate before atomically replacing its in-memory catalog. Invalid reloads
retain the last valid catalog and expose failure; invalid startup fails. The
mounted ConfigMap is Helm-owned and read without subPath; its propagation is
eventual. Publication waits for all serving Control Planes to report the expected
catalog digest. Different in-flight requests may use different valid catalog
versions during propagation; each accepted Run freezes one complete version.

The Control Plane validates selections using this catalog, and records the
resolved runtime capabilities and catalog digest alongside the existing Run model
identity. Worker dispatch/recovery and native children reuse that frozen snapshot.
Worker knows provider adapters, not a second model-name allowlist. Pending native
input uses the active Run's frozen modalities. No provider discovery or per-model
request SQL read is introduced. Frontend chat/admin choices and defaults come
from the existing catalog API. Tenant settings remain PG-owned; changing catalog
defaults does not rewrite existing selections, accepted Runs or native history.
Removing a model blocks new admissions for that model without changing accepted
work; an operator must explicitly change existing desired selections if needed.

This initial cutover changes the private Worker model contract and adds a Run
snapshot column. It requires a matched drained application upgrade. Completed
historical Runs retain their original identity; no speculative historical
capabilities are backfilled. No old-message decoder or silent model alias remains.
Later additions using existing adapters require only provider availability and
catalog publication. New adapters/protocols still require code and their checks.

Prepare the provider before exposing newly selectable models. A single provider
replica can interrupt HTTP/SSE during replacement. Pi remains the only sampling
retry owner; no Tool replay or automatic provider fallback is added. Rollback
requires compatible provider credential/data format and must not remove a route
needed by active accepted work. Catalog rollback affects future admission only.

## Verification and delivery

Use explicit impact scopes, not a free-form skip-checks switch. Provider releases
require source/image identity, image scanning, response/stream/error/cancellation
contracts and relevant real-model/native Tool acceptance. Catalog releases require
strict validation, public selection/default tests, frozen admission/child/recovery
snapshots and affected real capabilities. Full regression remains available for
schema, Pi, storage and execution changes. Existing immutable evidence may be
reused for unchanged images; it is never relabeled as a new scan.

Tests must cover invalid/replaced catalogs, a model unknown to the Worker build,
catalog changes during a Run and restoration, stale release baselines, forbidden
manifest changes, scan failure, failed replacement and subsequent reconciliation.
Live acceptance records Worker boot/lease and Cube/template identities across
provider/catalog publication, a real streaming failure/recovery outcome and
new-model execution. Required fixture cleanup precedes deletion of ownership.

Implementation slices: (1) catalog + frozen Run/Worker/UI contract; (2) component
manifest and scoped prepare/preflight/apply with impact checks; (3) matched initial
delivery, then actual provider/catalog-only updates and documented evidence.

Hosted CI classifies source changes with a dependency-free Git/Node step. Model
metadata uses the scoped contracts, provider edits select one image, and catalog
publication selects no image. Full or unclassified changes retain the full gate;
missing history defaults to full. Existing pinned CI actions are reused.
