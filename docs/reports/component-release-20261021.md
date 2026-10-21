# Component releases and runtime model catalog delivery

Status: deployed and accepted, 2026-10-21. Implements
[ADR-0267](../adr/0267-scoped-releases-and-model-catalog.md) and the approved
[provider/catalog release procedure](../COMPONENT_RELEASE.md).

## Serving combination

The initial matched release is `component-release-ad5fc83c`, schema
`196_model_runtime_snapshot`. Native Session topic v18, boot replies v3, guest
protocol 7 and completion startup 3 remain unchanged. The subsequent provider
release is `provider-scope-60bd7ef7`; its exact image ID is
`sha256:fca18b1b177a0d9c8cf6f48804365704220e3444619b0e7d1a9472d17b13062c`.
Operator revision `a63d932f` applied that previously scanned artifact without
rebuilding or relabeling its source. The ten other component identities and
original evidence references match the initial release.

The final catalog publication is `catalog-a63d932f4f87-mvhl0rv6`, restoring digest
`f7f3754f37e9f9ea9f8396a6cc6e8747b9bdd62d9db92fc980a7d1811279adaa`.
GPT-6.1 Sol remains the new-chat default and Luna remains the routine test model.
Main Helm revision is 69; infrastructure revision is 68. The current combination
and per-artifact provenance are recorded privately in `runtime/k3s/deployment.json`.

## Delivered behavior

- The Control Plane loads one validated Helm-owned JSON catalog. Chat and admin
  choices/defaults use its API. Worker has no model-name catalog to rebuild.
- Run admission persists complete model runtime capabilities and the catalog
  digest in the existing Run row. Claim/recovery and native child execution use
  that snapshot; active follow-up image checks also use it. No per-model-request
  SQL or second configuration service is added.
- Invalid configuration fails startup or preserves the last valid loaded catalog
  on reload, with visible operator status. Withdrawn choices cannot start new
  work; existing desired settings and historical Runs remain readable.
- Provider publication builds/scans/imports one image and changes only its Helm
  workload image. Catalog publication changes only the ConfigMap, with no hooks,
  migration Job or Pod-template update. Source/artifact/manifest and stale-baseline
  checks precede mutation. OS `flock` serializes maintained release operators.
- Each component retains its build origin and scan evidence. Explicitly bounded
  operator-only corrections may use an already prepared artifact; the operation
  records the operator revision separately. Runtime-input changes invalidate it.
- Hosted CI classifies provider-only, catalog-only, documentation and full changes.
  Provider-only builds one image; catalog-only builds none. Runtime/schema/
  dependency/workflow changes and missing history retain the full gate. Full CI
  includes the provider in its ten-image matrix. Existing pinned actions are reused.

## Verification

| Check | Evidence |
| --- | --- |
| Types, build, documentation and formatting | Pass; all workspace types plus final Control Plane check |
| Protocol package | 25 files / 156 tests pass |
| Worker package | 22 files / 89 tests pass |
| Catalog/provider contracts | Final catalog scope: 13 files / 76 tests pass, including real-PG snapshot isolation, unknown model identity, provenance, argument, scope and recovery guards |
| Native retry/storage | Initial Harness aggregate had 238 passes, 17 fixture failures and a two-test setup timeout; corrected HTTP fixture and real-PG reruns pass all 19 affected tests |
| Existing recovery and release helpers | Seven files / 25 tests pass |
| Browser presentation | Pass, including a model name supplied only by the API and chat/admin behavior |
| Helm, installer and image closure | Pass; actual catalog render has five entries and a volume mount without subPath |
| Docker build context | 11 Dockerfiles / 648 declared inputs; 15 excluded canaries remain excluded |
| Dependency and image checks | Source audit passes; initial eleven-image gate and later single-provider gate pass |
| Hosted CI configuration | Classification tests and workflow YAML checked locally; no remote GitHub run claimed |

The maintained live driver kept an actual Luna Bash Tool waiting for an uploaded
file. During that same Run, it applied the provider update in about **20.5 seconds**
(preflight/import/Helm/readiness), then published a temporary Luna output budget
of 32,768 instead of 65,536. It verified:

- all unrelated Pod identities, Worker boots, the Session lease and physical VM
  identity stayed unchanged;
- the accepted Run retained its complete original snapshot;
- another Run used the new snapshot and completed an actual Bash call;
- uploading the gate file allowed the original Tool and Run to complete normally;
- restoring the catalog required no application rebuild or restart.

Both native Runs completed, with four model requests in total. The original
catalog was restored; temporary Sessions, Workspace bytes and tenant records
were removed through the maintained cleanup boundaries.

Afterward, the unchanged Luna capability driver passed real function calling,
reading a **3,206,178-byte image returned by a function**, and one actual hosted
search call. Fast was accepted but returned `default`; effective acceleration
remains the separately recorded backlog item.

Final inventory confirms the original 32 tenants/users/API credentials, five
password credentials, 35 model profiles and 35 credential bindings, with matching
configuration fingerprints. Only normal API-credential last-use timestamps are
excluded from that comparison. No active Run, writer, binding, VM, development
machine, terminal or unpublished control remains. Every Pod is Ready; native
inventory confirms zero VMs on the recorded node. Linux and Windows localhost
both return HTTP 200.

## Corrected samples and limits

The first build exposed an excluded catalog COPY input; the exact file was added
to `.dockerignore` and real build-context checking now precedes full preparation.
Initial live fixtures hit an overlong tenant slug and an invalid 600-second Bash
parameter; the fixture uses native Pi's 300-second bound and fails immediately
if its Run settles early. Neither is a product Run-duration limit.
A malformed Helm argv was refused before any workload mutation; argument
validation and contract tests now cover it. Failed reports remain in private
evidence alongside the successful rerun; each fixture's cleanup is confirmed.

The live rollout occurred during a Tool wait. Broken model-stream retry/abort
behavior is covered by native Harness transport tests; this does not claim
seamless in-flight SSE migration, multi-replica proxy HA or fleet performance.
A single proxy replacement may interrupt a model request. New provider protocols
still require an adapter release, and routes needed by accepted work must remain
available. Pi core, Kafka ownership and Cube execution authorities are unchanged.

Private bounded evidence is under
`deploy/production/runtime/release-evidence/component-release-20261021/`, including
the `live-operator-fixed` report, catalog candidates/probes, source logs, failed
samples, image manifests and before/after fingerprints. No credentials or Session
transcripts are included in this report.
