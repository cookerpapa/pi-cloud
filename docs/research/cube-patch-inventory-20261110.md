# Complete Cube patch inventory

Date: 2026-11-10. Tracking: [#26](https://github.com/cookerpapa/pi-managed-agents/issues/26).
Scope: every patch loaded by `deploy/cubesandbox/runtime-build.json`, plus the
additional Dockerfile transformations in the maintained builder. PiCloud adapter,
Guest, Volume plugin and chart configuration are classified separately below.
This is an inventory of the current code, not authorization to remove a contract.

Baseline: CubeSandbox **v0.7.3**, commit `4411c96ba8658a959de34693f54f4918db2a432f`.
Manifest hashes were verified before counting. No Cube patch is removed by the
ADR-0308 public-admission changes. The prior 92-path runtime inventory was the
ADR-0306 baseline; it must not be used for this post-Guest-migration count.

This is the pre-migration baseline. Immutable patch links preserve the audit while
ADR-0309 removes those files and their consumers from the maintained runtime.

## Exact footprint

Counts are `git apply --numstat` changed lines, not total upstream LOC or the
number of independent features. Source files can contain embedded Rust tests;
"standalone tests" counts only separate test files. A replaced line contributes
one addition and one deletion. Generated code is shown separately.

| Active patch | Paths | Added lines | Removed lines | New files |
| --- | ---: | ---: | ---: | ---: |
| `0001-runtime-boundaries.patch` | 73 | 6,797 | 657 | 40 |
| `0002-release-dependencies.patch` | 14 | 364 | 264 | 0 |
| Total | 87 | 7,161 | 921 | 40 |

| File role | Paths | Added lines | Removed lines |
| --- | ---: | ---: | ---: |
| Source (including inline tests) | 41 | 3,379 | 169 |
| Standalone tests | 24 | 2,305 | 9 |
| Build / dependency inputs | 15 | 367 | 264 |
| Cube metadata migrations | 4 | 92 | 0 |
| Generated protobuf / gRPC | 2 | 985 | 479 |
| Protocol schema | 1 | 33 | 0 |

Net added lines: **6,240**. The 87 paths are 41 source files, 24 standalone test
files, four Cube database migrations, one protobuf definition, two generated
protobuf/gRPC files and 15 build/dependency inputs. These are not 87 independent
business features. Shared API/service files support several concerns below.

## Seven runtime responsibility groups

| Group | Behavior added or changed | Main upstream locations | Current PiCloud caller / reason for retaining it | Replacement boundary |
| --- | --- | --- | --- | --- |
| A. Recoverable allocation identity and closure | Persist a caller-issued allocation ID, immutable creation authorization, request fingerprint, node placement and original result; keep VM ID/token stable; reject ambiguous rescheduling and late create after close; retain uncertainty through restart and collect expired terminal receipts safely. | `CubeMaster/pkg/allocation/store.go`, `service/sandbox/allocation.go`, `sandbox_create.go`, `sandbox_run.go`, `sandbox_remove.go`; `Cubelet/pkg/allocation/{manager,store}.go`, `services/cubebox/allocation.go`, create-ID hook | `CubeSandboxRuntimeClient.allocation()`; provider `observeAllocation`, `#closeAllocation`, uncertain creation adoption; resource controller/release operator | The new public admission rules remove one cancellation race, but do not replace elastic/child preparation or recover missing native identities. An external owner must have a complete original-operation lookup/reconciliation contract. |
| B. Physical presence and truthful observed state | Inspect the recorded node and full sandbox identity independently of Master aliases. Distinguish absent from node/metadata/runtime unavailability. Consult native container/task metadata when the in-memory catalog is incomplete. Preserve stopped/error/unknown rather than presenting them as running. | CubeAPI `models`/`services/sandboxes`; Master `sandbox_info.go`; Cubelet `cubes/observe.go` and exact-ID `List` | Runtime client `observe()`; provider `observeRuntime`, `#confirmInstanceAbsent`; machine recovery and quota release | A provider-owned authoritative deletion/status response or a trusted node adapter can replace this. A missing cache entry or generic 404 cannot. State-mapping fixes are also upstream candidates. |
| C. Volume admission and recoverable references | Reserve Volume holds before node creation; close new attachment admission before deletion; reconcile recorded nodes with store incarnation/revision; preserve unknown holders and unfinished detach across restart; require confirmed release before deleting bytes. | Master `allocation/volumes.go`, `volume_references.go`, `httpservice/cube/volume.go`, volume resolution gate; Cubelet Volume manager/refcount store/state/reference RPC | Existing `DELETE /volumes/:id` for `picloud-posix`; `WorkspaceVolumeDeletionReaper` -> provider `deleteWorkspaceVolume` | Official binary/RPC Volume Plugin is the preferred external candidate. Persistent holds, deletion exclusion, failed hooks and node-restart evidence must be proved before cutover. The native basic refcount/409 guard already exists. |
| D. Finite elastic retention | Store the retention deadline in the existing allocation journal; renew from the original activity timestamp; refuse stale/closed renewal; expire compute after renewal stops even if a Tool is unconfirmed; retry unfinished physical cleanup. | Master `allocation_retention.go`; Cubelet `pkg/allocation/retention.go`, cleanup loop and lifecycle integration | Runtime client `renewRetention()`; provider `renewPersistentRetention` and interactive-terminal retention; execution-side Session activity | Stock idle timeout/LCM behavior is a candidate, but traffic refresh, delayed renewal, paused state and cleanup must preserve the selected resource policy. Do not introduce a competing clock. |
| E. Recoverable raw lifecycle history | Record bounded provider observations with source epoch/sequence, history coverage/gaps and long-poll reads. Persist the node history and expose it through Master/API. It does not compute prices or charge users. | Cubelet `pkg/lifecyclejournal/journal.go`, `services/cubebox/lifecycle_history.go`; Master/API lifecycle routes | `packages/accounting/src/cube-lifecycle-source.ts` -> independent collector/PG accounting | Upstream Redis lifecycle publication deliberately swallows failures. Removing this requires an accepted alternative history/coverage source; the two new product rules do not supply it. |
| F. Managed pause/resume and snapshot cleanup | Preserve the fixed allocation ID through resume; close managed allocations through the correct physical path; clean paused snapshot packages using the current address of the original node; retain pause metadata when cleanup fails. | Cubelet create-ID hook and allocation service; Master `pausesnap/delete_paused.go`, allocation pause cleanup | Managed allocation close and maintenance retirement; pause/resume/recovery through provider | Native pause/delete already exists. These changes bridge it to managed allocations and repair address/cleanup confirmation. Review together with removing A, not as an independent scheduler. |
| G. Template/artifact cleanup after node-address changes | Resolve current node addresses instead of stale recorded Pod IPs; deduplicate cleanup targets by node ID; match placement by identity; preserve unresolved/shared artifact evidence on cleanup failure. | Master `templatecenter/{delete,distribution,artifact_lifecycle}.go` and related tests; same source imported by Template Center | Native template/artifact GC during template retirement and matched publication | Independent upstream bug fixes. Public machine admission rules do not replace them; compare with an upstream revision containing equivalent fixes. |

## Connection credentials are a consumer, not another patch subsystem

Cold fixed-Guest control currently calls `#guestInstance()` in
`packages/sandbox-control/src/cubesandbox-runtime-client.ts`. Ordinary detail
inspection omits `trafficAccessToken`, so a cold cache reads the original managed
allocation receipt. The same receipt supplies stable node/VM identity and token.
This is a use of **A**, not an eighth independent business patch.

Already-successful allocations also retain connection data in the encrypted
`runtime_capsule` / binding `dataCapsule`; `persistentCapsule()` stores the original
instance and `attachExecutionData()` opens that data channel. Reusing that existing
trusted data when warming the Guest-control client is a concrete adapter-side
replacement candidate. It must preserve identity and deliberate pause. It would
remove this caller's extra receipt lookup, not solve creation whose original reply
was never durably received. No new credential table is inherently required.

## Supporting changes, counted but not extra business features

- API bridges: `POST /allocations/:id/get|close|renew`,
  `GET /sandboxes/:id/observation?nodeID=...`, and
  `POST /lifecycle/sources|history`; Master forwarding and OpenAPI declarations.
- Node RPCs: `ManageAllocation`, `ObserveVolumeReferences`, `ReadLifecycle`, with
  request/reply definitions and regenerated Go/protobuf/grpc code.
- Four migrations support Cube's own MySQL/PostgreSQL metadata backends. They are
  not new PiCloud Run, Tool-result or conversation-history tables.
- Cubelet reference metadata uses synchronous Bolt writes, and stale references
  are marked for reconciliation instead of discarded at startup. These support
  A/C's durability; they are not a separate product feature.
- Source integration starts/stops the journal/managers and extends the existing
  cleanup loop. The `.dockerignore` addition brings the matching protobuf into
  the Cubelet build. Tests cover these same contracts.

## Dependency and build changes

`0002-release-dependencies.patch` changes 14 paths only: Rust toolchain/Dockerfile,
CubeMaster/Cubelet runtime packages, and Go module/checksum files for CubeMaster,
Cubelet, CubeTemplateCenter, CubeNet/cubevs and the S3 Volume example.

Representative changes include Rust 1.85 -> 1.85.1; the explicit Go 1.26 toolchain;
containerd 1.7.33 / 2.2.7; gRPC 1.83.2; Kubernetes Go modules 0.34.10; Go x/*,
OpenTelemetry, compression/parser and related dependency fixes. Ubuntu APT,
libapt, Brotli and OpenSSL packages are pinned where required. This patch contains
no Agent/Tool dispatch, pricing, Session or Volume-lifecycle implementation.

The builder (`scripts/build-cubesandbox-runtime.mjs`) performs additional **build
transformations outside both .patch files**. It derives four Dockerfiles for
CubeAPI, CubeMaster, CubeTemplateCenter and Cubelet:

1. Upgrade Alpine runtime packages for CubeAPI.
2. Add the reviewed APT/libapt/Brotli update to Template Center's runtime stage.
3. Optionally substitute the configured HTTPS Ubuntu mirror.
4. Replace supported base tags with manifest-pinned image digests.
5. Configure the Go module proxy, local toolchain and read-only module resolution.
6. Build cubecow with `cargo --locked`.
7. Copy the corresponding Docker ignore policy and attach version/revision/patch
   labels and pinned builder arguments.

Those derived Dockerfiles are not additional runtime features. Template Center's
Dockerfile adjustment is not visible in the 87-path patch numstat, so two patch
files alone are not the entire image customization surface. Their base/digest
configuration remains in `runtime-build.json`.

## Outside the Cube source-patch count

PiCloud owns the fixed Guest service/tool program, POSIX Volume Plugin, resource
provider adapter, API authorizer, egress gateway, Volume Gateway/quota service,
Helm rendering and versioned image recipes. These are external application,
plugin, adapter or deployment code, not edits to Cube source. They still require
maintenance; stock Cube compatibility would not imply deleting them all.

Native Cube Tool admission, Tool cancellation/probe handlers, Node completion
forwarding, Kafka/PG/S3 completion clients and compute pricing/interval generation
are **not** remaining Cube responsibilities. Tool operation authority now lives
in the fixed Guest; completion and valuation live in their independent services.
Resource observation/retention/history above must not be confused with that
removed Tool execution manager.

## Removal order to evaluate

First reuse existing capsule data for cold execution connections; next exercise
Volume Plugin ownership and conservative external resource reconciliation. Assess
native timeout/LCM and lifecycle-history coverage separately. Upstream template/
state-mapping fixes and dependency upgrades form independent maintenance work.
Each candidate needs a contract test and one authority at cutover. This inventory
does not assert that every item is inherently impossible to move outside Cube,
or that deleting the two patch files preserves current behavior.

## Complete file inventory

`New` distinguishes newly added upstream paths from changes to existing files.
Each link points at that file's patch header; shared source files intentionally
appear once here. The following tables cover every active manifest path.

### 0001-runtime-boundaries.patch

| Upstream path | Role | New | + | − | Patch |
| --- | --- | --- | ---: | ---: | --- |
| `CubeAPI/src/cubemaster/mod.rs` | Source (including inline tests) | no | 45 | 0 | [L1](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1) |
| `CubeAPI/src/handlers/sandboxes.rs` | Source (including inline tests) | no | 49 | 0 | [L64](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L64) |
| `CubeAPI/src/models/mod.rs` | Source (including inline tests) | no | 30 | 1 | [L126](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L126) |
| `CubeAPI/src/openapi.rs` | Source (including inline tests) | no | 5 | 0 | [L174](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L174) |
| `CubeAPI/src/routes.rs` | Source (including inline tests) | no | 10 | 0 | [L197](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L197) |
| `CubeAPI/src/services/sandboxes.rs` | Source (including inline tests) | no | 166 | 4 | [L236](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L236) |
| `CubeMaster/pkg/allocation/store.go` | Source (including inline tests) | yes | 255 | 0 | [L461](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L461) |
| `CubeMaster/pkg/allocation/store_test.go` | Standalone tests | yes | 147 | 0 | [L722](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L722) |
| `CubeMaster/pkg/allocation/volumes.go` | Source (including inline tests) | yes | 298 | 0 | [L875](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L875) |
| `CubeMaster/pkg/allocation/volumes_test.go` | Standalone tests | yes | 204 | 0 | [L1179](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1179) |
| `CubeMaster/pkg/pausesnap/delete_paused.go` | Source (including inline tests) | no | 21 | 1 | [L1389](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1389) |
| `CubeMaster/pkg/pausesnap/delete_paused_test.go` | Standalone tests | no | 46 | 0 | [L1436](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1436) |
| `CubeMaster/pkg/service/httpservice/cube/lifecycle_history.go` | Source (including inline tests) | yes | 67 | 0 | [L1493](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1493) |
| `CubeMaster/pkg/service/httpservice/cube/managed_allocation.go` | Source (including inline tests) | yes | 81 | 0 | [L1566](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1566) |
| `CubeMaster/pkg/service/httpservice/cube/routes.go` | Source (including inline tests) | no | 2 | 0 | [L1653](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1653) |
| `CubeMaster/pkg/service/httpservice/cube/sandbox_create.go` | Source (including inline tests) | no | 9 | 0 | [L1666](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1666) |
| `CubeMaster/pkg/service/httpservice/cube/volume.go` | Source (including inline tests) | no | 32 | 0 | [L1686](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1686) |
| `CubeMaster/pkg/service/sandbox/allocation.go` | Source (including inline tests) | yes | 331 | 0 | [L1739](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L1739) |
| `CubeMaster/pkg/service/sandbox/allocation_pause_test.go` | Standalone tests | yes | 84 | 0 | [L2076](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2076) |
| `CubeMaster/pkg/service/sandbox/allocation_retention.go` | Source (including inline tests) | yes | 52 | 0 | [L2166](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2166) |
| `CubeMaster/pkg/service/sandbox/sandbox_info.go` | Source (including inline tests) | no | 8 | 1 | [L2224](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2224) |
| `CubeMaster/pkg/service/sandbox/sandbox_observation_test.go` | Standalone tests | yes | 57 | 0 | [L2256](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2256) |
| `CubeMaster/pkg/service/sandbox/sandbox_remove.go` | Source (including inline tests) | no | 20 | 0 | [L2319](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2319) |
| `CubeMaster/pkg/service/sandbox/sandbox_run.go` | Source (including inline tests) | no | 44 | 3 | [L2357](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2357) |
| `CubeMaster/pkg/service/sandbox/util.go` | Source (including inline tests) | no | 3 | 0 | [L2473](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2473) |
| `CubeMaster/pkg/service/sandbox/volume_references.go` | Source (including inline tests) | yes | 64 | 0 | [L2487](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2487) |
| `CubeMaster/pkg/templatecenter/artifact_lifecycle.go` | Source (including inline tests) | no | 4 | 14 | [L2557](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2557) |
| `CubeMaster/pkg/templatecenter/cleanup_node_routing_mysql_test.go` | Standalone tests | yes | 118 | 0 | [L2595](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2595) |
| `CubeMaster/pkg/templatecenter/cleanup_node_routing_test.go` | Standalone tests | yes | 155 | 0 | [L2719](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2719) |
| `CubeMaster/pkg/templatecenter/delete.go` | Source (including inline tests) | no | 33 | 25 | [L2880](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2880) |
| `CubeMaster/pkg/templatecenter/delete_test.go` | Standalone tests | no | 11 | 8 | [L2978](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L2978) |
| `CubeMaster/pkg/templatecenter/distribution.go` | Source (including inline tests) | no | 3 | 8 | [L3066](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3066) |
| `CubeMaster/pkg/templatecenter/snapshot_reconciler_test.go` | Standalone tests | no | 1 | 1 | [L3096](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3096) |
| `Cubelet/Dockerfile.dockerignore` | Build / dependency inputs | no | 3 | 0 | [L3109](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3109) |
| `Cubelet/pkg/allocation/manager.go` | Source (including inline tests) | yes | 169 | 0 | [L3120](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3120) |
| `Cubelet/pkg/allocation/manager_test.go` | Standalone tests | yes | 237 | 0 | [L3295](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3295) |
| `Cubelet/pkg/allocation/receipt_recovery_test.go` | Standalone tests | yes | 83 | 0 | [L3538](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3538) |
| `Cubelet/pkg/allocation/retention.go` | Source (including inline tests) | yes | 109 | 0 | [L3627](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3627) |
| `Cubelet/pkg/allocation/retention_test.go` | Standalone tests | yes | 122 | 0 | [L3742](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3742) |
| `Cubelet/pkg/allocation/store.go` | Source (including inline tests) | yes | 201 | 0 | [L3870](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L3870) |
| `Cubelet/pkg/allocation/volume_evidence_test.go` | Standalone tests | yes | 76 | 0 | [L4077](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4077) |
| `Cubelet/pkg/lifecyclejournal/journal.go` | Source (including inline tests) | yes | 296 | 0 | [L4159](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4159) |
| `Cubelet/pkg/lifecyclejournal/journal_test.go` | Standalone tests | yes | 98 | 0 | [L4461](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4461) |
| `Cubelet/plugins/cube/internals/createid/managed_resume_test.go` | Standalone tests | yes | 39 | 0 | [L4565](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4565) |
| `Cubelet/plugins/cube/internals/createid/plugin.go` | Source (including inline tests) | no | 13 | 4 | [L4610](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4610) |
| `Cubelet/plugins/cube/internals/cubes/observe.go` | Source (including inline tests) | yes | 61 | 0 | [L4649](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4649) |
| `Cubelet/plugins/cube/internals/cubes/observe_test.go` | Standalone tests | yes | 55 | 0 | [L4716](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4716) |
| `Cubelet/plugins/cube/internals/cubes/plugin.go` | Source (including inline tests) | no | 2 | 0 | [L4777](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4777) |
| `Cubelet/plugins/volume/interface.go` | Source (including inline tests) | no | 2 | 1 | [L4790](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4790) |
| `Cubelet/plugins/volume/manager.go` | Source (including inline tests) | no | 123 | 52 | [L4804](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L4804) |
| `Cubelet/plugins/volume/posix_recovery_test.go` | Standalone tests | yes | 149 | 0 | [L5062](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L5062) |
| `Cubelet/plugins/volume/refcount/state.go` | Source (including inline tests) | yes | 113 | 0 | [L5217](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L5217) |
| `Cubelet/plugins/volume/refcount/store.go` | Source (including inline tests) | no | 43 | 37 | [L5336](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L5336) |
| `Cubelet/plugins/volume/reference_recovery_test.go` | Standalone tests | yes | 190 | 0 | [L5504](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L5504) |
| `Cubelet/plugins/volume/stale_reference_test.go` | Standalone tests | yes | 229 | 0 | [L5700](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L5700) |
| `Cubelet/services/cubebox/allocation.go` | Source (including inline tests) | yes | 222 | 0 | [L5935](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L5935) |
| `Cubelet/services/cubebox/allocation_cleanup_test.go` | Standalone tests | yes | 44 | 0 | [L6163](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6163) |
| `Cubelet/services/cubebox/lifecycle_history.go` | Source (including inline tests) | yes | 264 | 0 | [L6213](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6213) |
| `Cubelet/services/cubebox/lifecycle_history_test.go` | Standalone tests | yes | 42 | 0 | [L6483](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6483) |
| `Cubelet/services/cubebox/observation_test.go` | Standalone tests | yes | 42 | 0 | [L6531](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6531) |
| `Cubelet/services/cubebox/resume_reconcile_test.go` | Standalone tests | no | 9 | 0 | [L6579](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6579) |
| `Cubelet/services/cubebox/service.go` | Source (including inline tests) | no | 69 | 15 | [L6606](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6606) |
| `Cubelet/services/cubebox/volume_holder_evidence_test.go` | Standalone tests | yes | 67 | 0 | [L6773](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6773) |
| `Cubelet/services/cubebox/volume_references.go` | Source (including inline tests) | yes | 55 | 0 | [L6846](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6846) |
| `Cubelet/storage/local.go` | Source (including inline tests) | no | 3 | 1 | [L6907](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6907) |
| `Cubelet/storage/plugin.go` | Source (including inline tests) | no | 2 | 2 | [L6922](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6922) |
| `pkgs/cubedb/migrate/migrations/mysql/20261004000000_pi_cloud_allocation.sql` | Cube metadata migrations | yes | 24 | 0 | [L6937](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6937) |
| `pkgs/cubedb/migrate/migrations/mysql/20261005000000_pi_cloud_volume_state.sql` | Cube metadata migrations | yes | 22 | 0 | [L6967](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6967) |
| `pkgs/cubedb/migrate/migrations/postgres/20261004000000_pi_cloud_allocation.sql` | Cube metadata migrations | yes | 24 | 0 | [L6995](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L6995) |
| `pkgs/cubedb/migrate/migrations/postgres/20261005000000_pi_cloud_volume_state.sql` | Cube metadata migrations | yes | 22 | 0 | [L7025](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L7025) |
| `pkgs/proto/services/cubebox/v1/cubebox.pb.go` | Generated protobuf / gRPC | no | 871 | 479 | [L7053](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L7053) |
| `pkgs/proto/services/cubebox/v1/cubebox.proto` | Protocol schema | no | 33 | 0 | [L10165](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L10165) |
| `pkgs/proto/services/cubebox/v1/cubebox_grpc.pb.go` | Generated protobuf / gRPC | no | 114 | 0 | [L10216](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0001-runtime-boundaries.patch#L10216) |

### 0002-release-dependencies.patch

| Upstream path | Role | New | + | − | Patch |
| --- | --- | --- | ---: | ---: | --- |
| `CubeAPI/Dockerfile` | Build / dependency inputs | no | 1 | 1 | [L1](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L1) |
| `CubeAPI/rust-toolchain.toml` | Build / dependency inputs | no | 1 | 1 | [L14](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L14) |
| `CubeMaster/docker/Dockerfile` | Build / dependency inputs | no | 3 | 1 | [L22](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L22) |
| `CubeMaster/go.mod` | Build / dependency inputs | no | 18 | 18 | [L38](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L38) |
| `CubeMaster/go.sum` | Build / dependency inputs | no | 36 | 36 | [L125](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L125) |
| `CubeNet/cubevs/go.mod` | Build / dependency inputs | no | 3 | 3 | [L265](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L265) |
| `CubeNet/cubevs/go.sum` | Build / dependency inputs | no | 4 | 4 | [L291](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L291) |
| `CubeTemplateCenter/go.mod` | Build / dependency inputs | no | 15 | 15 | [L317](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L317) |
| `CubeTemplateCenter/go.sum` | Build / dependency inputs | no | 38 | 38 | [L388](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L388) |
| `Cubelet/Dockerfile` | Build / dependency inputs | no | 8 | 1 | [L557](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L557) |
| `Cubelet/go.mod` | Build / dependency inputs | no | 27 | 28 | [L586](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L586) |
| `Cubelet/go.sum` | Build / dependency inputs | no | 197 | 105 | [L727](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L727) |
| `examples/volume/s3/go.mod` | Build / dependency inputs | no | 5 | 5 | [L1468](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L1468) |
| `examples/volume/s3/go.sum` | Build / dependency inputs | no | 8 | 8 | [L1494](https://github.com/cookerpapa/pi-managed-agents/blob/e1eaeb1d/deploy/cubesandbox/patches/0002-release-dependencies.patch#L1494) |

## Reproduce the counts

```sh
git apply --numstat deploy/cubesandbox/patches/0001-runtime-boundaries.patch
git apply --numstat deploy/cubesandbox/patches/0002-release-dependencies.patch
```

Read those alongside the active manifest and builder; an old checkout diff, a
community proposal or a previously removed patch is not part of this inventory.
