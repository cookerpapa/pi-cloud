# Repository decoupling and release review — 2026-11-12

Baseline: `main`, `ae05797e`. Tracking: [review #32](https://github.com/cookerpapa/pi-managed-agents/issues/32),
[release scope #33](https://github.com/cookerpapa/pi-managed-agents/issues/33).
This is a source/configuration review with isolated checks. No serving component,
user Session, Workspace, device or credential was changed.

**Decision: discuss the remaining coupling before expanding release scopes.**
Keep PG, Kafka, Pi Workers, the single Session Projector, independent Tool host,
completion receiver and resource management. The review found no reason to
replace those authorities or add another scheduler. Their runtime separation is
substantially better than their configuration, build and maintenance separation.

The findings below are eight work groups, not eight demonstrated data-loss bugs.
P2 denotes an architectural/operational correction; P3 denotes maintenance work.
Existing explicitly supported component releases remain useful. This report does
not authorize bypassing their guards or implementing #30/#31 incidentally.

## Coverage and method

- Inventoried 2,640 tracked files and all 25 workspace packages. Read maintained
  architecture and recent ADR/delivery boundaries before inspecting older code.
- Traced production entrypoints, role assembly, native Tool and ordinary Tool
  dispatch, original replies, resource activity/retirement, persistence, dynamic
  catalogs and the release operators. Inspected callers and relevant tests.
- Built in-memory esbuild dependency descriptions for ten service entrypoints;
  no generated bundle was executed or published. These distinguish source used by
  a role from files merely copied into its image. They are review evidence, not
  a proposed authoritative release dependency algorithm.
- Inspected all tracked test files as an inventory, collected current test names,
  cross-checked the fault manifest, and ran eight focused test files serially.
  Collection is not execution. No full model/KVM/PG/RF3 acceptance was rerun.
- Reviewed current documentation, installation/publication scripts, Helm templates,
  dependency manifests, migration registration and historical experiment boundaries.

This is repository-wide architectural coverage, not an assertion that every line
received equal scrutiny. No node-level HA, provider interoperability or absence
of all functional bugs is established by these checks.

| Area | Inspected boundary |
| --- | --- |
| `control-plane` | Public API, Session runtime, resource manager, ordinary Tool host, resource admission, schedules/SCM and catalogs |
| `supervisor-host`, `sandbox-supervisor`, `runtime-core` | Worker claim/renewal, public Pi ports, native intent/publication, replacement, cancellation and projection |
| `database`, `pi-session-postgres`, `event-log` | Authority/current state, native history, cold recovery, ordered control changes and original reply references |
| `sandbox-control`, `tool-sandbox`, `workspace-runtime` | Binding view, lazy preparation, Guest effects, probes/activity, physical cleanup, files and upload staging |
| `boxlite-node`, `android-executor` | Explicit native adapters, fixed Guest/device capabilities and remaining storage dependencies |
| `accounting`, `session-attachments`, `subagent-control` | Independent metering, retained originals and native Conversation control |
| `web-ui`, `ssh-gateway` | API/stream/file/terminal boundaries, resource selection and source/build separation |
| `cube-api-authorizer`, `cube-egress-gateway`, `provider-egress-relay` | Native API/egress/provider transport boundaries and deployment inputs |
| `protocol`, `domain`, `observability`, `fake-model-server` | Shared contracts, configuration dependencies, operational evidence and test-only provider behavior |
| Scripts, charts, docs | Matched/scoped operators, CI classification, artifact provenance, current versus historical guidance |

## Boundaries that should be retained

- Worker Tool proxies publish logical intent and restore the original reply wait.
  They do not select a physical Cube/BoxLite VM or invoke provider lifecycle APIs.
  `SandboxRuntimeIdentity` in the runner is a trusted runtime/Worker identity;
  its old name is not evidence of a VM allocation authority.
- Fixed Guest Tool dispatch uses the partition owner's binding view. Activity
  maintenance consumes bounded Session declarations and resource metadata rather
  than polling Worker leases. Cold resource lookup is not a per-Tool lease check.
- Native history remains one ordered Session stream. Ordinary live text and
  canonical settlement have their existing storage policies; this review found
  no reason to add a second log, operation ledger or cache authority.
- Completion is an independent HTTPS role; original reply topics/positions and
  deadlines survive Worker replacement. Replaying a projection does not replay
  arbitrary shell work.
- Resource management owns lifecycle/expiry, and Workspace deletion retains
  exact attachment and physical cleanup evidence. Missing heartbeats or inventory
  are not deletion receipts.
- The API does not run the Projector or Pi Harness. Ordinary Tool implementations
  can already be published through the maintained Tool-host scope. Model/provider
  and presentation-only Web scopes also exist.

Relevant current implementations include [Worker assembly](../../packages/supervisor-host/src/runtime.ts),
[logical preparation](../../packages/sandbox-control/src/tool-environment-coordinator.ts),
[binding view](../../packages/sandbox-control/src/sandbox-binding-view.ts),
[activity view](../../packages/sandbox-control/src/session-activity-retention.ts),
[completion](../../packages/cube-completion/src/main.ts) and
[resource expiry](../../packages/sandbox-control/src/resource-idle-expiry.ts).

## Findings

### R01 — P2: control Tool dispatch still reads Worker lease authority

[ControlToolDispatcher](../../packages/control-plane/src/control-tool-dispatcher.ts#L270)
loads native records/commits and joins `active_execution_scopes` before dispatch.
Line 291 checks `valid_until > clock_timestamp()` and `accepting_effects`.
That view derives its time from `session_leases`; it is not merely a Tool result
index. The load is also repeated when pending work/replies are reconsidered.

For example, an ordinary `preview`, image or Skill call passes through this
branch, while a fixed Guest Bash call uses the memory routing view. It is therefore
incorrect to describe all Projector-side Tool dispatch as independent of the PG
Worker lease schema/clock. This is an existing intentional control-effect gate,
not evidence that its checks can simply be deleted.

**Proposed decision:** separate ordered dispatch identity/task state from the
transactional authority needed by a particular control mutation. Examine whether
the already-consumed complete native intent and ordered task/closure view can
supply the former; keep necessary resource, tenant and mutation checks with the
handler's transaction. Cold restoration may still read native storage. Do not
introduce a second effect queue or claim that Kafka alone authorizes every PG
mutation. Cover cancellation/closure races and lost reply publication before
removing any gate.

Rare closure/recovery paths also consult PG intentionally, for example
[environment notification](../../packages/sandbox-control/src/sandbox-session-runtime.ts#L489)
and [environment recovery](../../packages/sandbox-control/src/environment-recovery.ts).
These must not be confused with ordinary retention polling.

### R02 — P2: process separation still shares a broad startup contract

[Session API](../../packages/control-plane/src/session-api-main.ts#L37),
[Session runtime](../../packages/control-plane/src/session-runtime-main.ts#L67)
and [management](../../packages/control-plane/src/main.ts#L26) all load
`ProductionControlPlaneConfig`. Its loader requires Worker enrollment and
management-template configuration even for the public API role, which does not
enroll Workers. The shared Helm secret-mount helper reflects the same boundary.

An isolated loader probe accepted a complete synthetic configuration, then
rejected removal of each of `PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN`,
`PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES` and
`PI_CLOUD_SUPERVISOR_ID_PREFIX`. No service or network request was started.
The public API does not consume those fields in its assembly. A change to the
Worker provisioning configuration can therefore prevent an unrelated API
replacement from starting.

Session execution also calls
[the full Sandbox configuration loader and transport constructor](../../packages/sandbox-control/src/sandbox-session-runtime.ts#L54).
Its data/execution consumers are narrow, but construction still creates the broad
provider object and requires management-oriented settings. This is dependency
coupling, not a finding that the Projector currently destroys VMs.

**Proposed correction:** role-specific configuration and construction ports,
sharing small common parsers. Keep the existing processes initially. Split the
runtime's execution/data client from lifecycle/storage construction before deciding
whether a separate provider-adapter process is worth operating. Add startup tests
with irrelevant role settings absent.

### R03 — P2, known gap: compute selection still controls storage and cluster setup

[Transport assembly](../../packages/sandbox-control/src/sandbox-runtime-transport.ts#L22)
always constructs a Cube client. The BoxLite branch passes it as `volumes` at
line 58. [GuestRuntimeClient](../../packages/sandbox-control/src/guest-runtime-client.ts#L57)
still combines execution with `ensureVolume/deleteVolume`.

The selected implementation and endpoint set come from startup configuration.
The resource form exposes a profile, not an administrator-maintained cluster and
template directory. Existing `sandbox_domains` routing is a foundation, not proof
that dynamic registration already works. Multiple management URLs in the current
assembly must not be treated as an arbitrary heterogeneous backend registry.

**Proposed correction:** follow [#30](https://github.com/cookerpapa/pi-managed-agents/issues/30)
for persistence behavior, including vendor-retained sandboxes without invented
volumes, and [#31](https://github.com/cookerpapa/pi-managed-agents/issues/31) for
stable backend identity, explicit placement/capabilities and live registration.
Preserve immutable targets for operations/cleanup. These are architectural
changes requiring decisions and acceptance, not just a UI selector.

### R04 — P2: images carry substantially broader code than their roles use

[The Worker Dockerfile](../../packages/supervisor-host/Dockerfile#L50) copies both
`packages/accounting/src` and the entire `packages/control-plane/src` tree.
The in-memory Worker entrypoint bundle had no contributing source from either
package. It did use the Sandbox client boundary, which belongs behind a narrow
port rather than implying a need for all provider management code.

The shared Control Plane artifact supplies six separately deployed roles: API,
Session runtime, management, Tool host, metering and completion. Sharing an image
does **not** force all six to roll; the existing scoped operator already keeps
separate per-role image references. However, a generic plan based only on Docker
COPY inputs would overestimate which running roles actually changed.

**Proposed correction:** document runtime consumers separately from artifact
inputs, narrow Worker build contents/dependencies, and decide which role build
targets are useful. Reuse base/dependency layers. Avoid creating new processes
merely to make package directories look independent. Preserve exact retained-image
provenance when a role continues using an older compatible artifact.

### R05 — P2: release policy still turns small changes into full work

[releaseImpact](../../scripts/lib/release-impact.mjs#L207) recognizes API and
ordinary Tool paths, but its generic fallback classifies all of these single-file
changes as `full`, with ten CI image builds:

- `packages/web-ui/src/ResourceManagementPage.tsx`;
- `packages/supervisor-host/src/model-gateway.ts`;
- `packages/sandbox-control/src/session-activity-retention.ts`;
- even `AGENTS.md`.

The first three have corresponding manual scoped capabilities. This mismatch was
reproduced by calling the current pure classification function; it does not mean
that a full deployment actually occurred during this review.

The [matched operator](../../scripts/run-matched-release.mjs#L123) always prepares
native Cube inputs, Guest and application images. Apply retires compute and enters
storage/native maintenance even when unchanged contracts might not need it. Its
fourteen-image scan requirement is distinct from the ten-image CI build matrix.
It still invokes the completed private-Cube-table retirement on every matched
publication at [line 484](../../scripts/run-matched-release.mjs#L484).

There is also a future chart-version coupling: the common
[label helper](../../deploy/helm/pi-cloud-platform/templates/_helpers.tpl#L5)
places the root chart version in Pod template labels. Rendering two temporary
copies with **only the root Chart version changed** changed 9 of 11 workload Pod
templates. Tool-host and the separately versioned Worker subchart were unchanged.
The currently fixed chart version does not explain every past rollout; this is
a concrete barrier to future narrow chart changes. No Helm apply was performed.

**Proposed correction:** after the boundary decisions, use one role/artifact/
contract impact policy for CI, operator preflight and acceptance selection. Separate
build, rollout and physical maintenance decisions. Remove purely informational
chart-version changes from unrelated Pod templates. Keep protocol/schema consumers,
writer closure and required physical retirement coordinated. Do not weaken checks
to get a smaller manifest through the current allowlist.

### R06 — P3: development cutovers remain part of normal bootstrap/publication

The migration directory contains 219 numbered migrations plus its index. Several
create obsolete layouts only for later migrations to remove them. They remain
required by today's fresh-install path, so deleting them individually would break
installation.

[Bootstrap](../../packages/control-plane/src/bootstrap-main.ts#L23) also still
calls `upgradeSharedHistory` and `upgradeForkProvenance` on every run. Historical
cutover tests recreate older Turn/archive/model layouts specifically to test those
transitions. This is development-upgrade maintenance, not current Run behavior.

Other concrete candidates are the completed native extension-table cleanup,
provider numeric-YAML spelling conversion and old Tool-host network-rule repair
in [component release](../../scripts/lib/component-release.mjs#L293), plus removed
Tool-host helper filenames retained in source allowlists. Some historical
experiments have their own package lock/runtime scaffolding outside the workspaces.

**Proposed correction:** establish a clean current schema baseline, compare its
tables/indexes/constraints/functions/triggers with the existing final schema,
preserve required account/configuration/credential and storage ownership data,
then retire obsolete upgrade handlers, flags and transition-only tests together.
Keep current behavior/concurrency tests. Remove completed release exceptions only
after their baseline assumptions are confirmed. Do not discard unknown attachments,
recovery tooling or physical cleanup guards as "old code".

Historical experiments can move to Git history with their result reports retained;
they should not be maintained as executable alternate production paths. For example,
the old Pi adoption experiment already explicitly declares itself historical.

### R07 — P2/P3: current operational guidance contains superseded topology

The root README was recently updated and is not wholly obsolete. The clearest
drift is in linked/current guides:

- [Distributed deployment](../DISTRIBUTED_DEPLOYMENT.md#L3) says lifecycle and
  dispatch are modules of every Control Plane replica. Its diagram at line 38
  still puts a control-plane ingress between Worker and Kafka. Both contradict
  current direct publication and separate roles.
- [Component releases](../COMPONENT_RELEASE.md#L7) still describes the Tool-host
  integration as source implementation/pending acceptance, although #16 is delivered.
- [Release process](../RELEASE_PROCESS.md#L144) retains migration-156/157 recipes
  as current instructions. The 782-line matched guide and lengthy roadmap/backlog
  interleave many completed cutovers with the present operating procedure.
- [Architecture](../ARCHITECTURE.md#L372) still mentions direct native retention
  transport in its provider paragraph, while ADR-0314 now renews PG deadlines.
- Public package README titles, image descriptions and some generated report/note
  text still use the old brand. Protocol/package/env/topic/path identities remain
  intentional technical names under AGENTS.md and must not be globally replaced.

**README changes proposed:** keep the current message/authority diagram; make the
supported backend/default/validation limits compact and prominent; describe shared
image versus independent roles; state the remaining Cube storage dependency; link
current release choices rather than several historical cutover narratives. Keep
stock compute's unconfirmed/unpriced status and single-node acceptance limits.

**Documentation cleanup:** one current operating procedure per topic, with old
steps moved to named evidence/Git history. Preserve ADR rationale and upstream
attribution. A link checker cannot validate architectural freshness: the maintained
checker passed 40 files, and a broader 43-guide relative-link check also passed
despite the topology errors above.

### R08 — P3: test selection is fragile, but the fault suite is not mostly dead

There are 452 tracked test-definition files. Collection found 2,536 package test
items with the relevant PG collection flags plus 307 script-helper items. Some
live/integration gates remain opt-in; these figures are not a full executed pass.

All 430 fault-manifest targets map to current collected names, with no duplicate
file/name target and no missing test file. Seventy-one initially absent targets
were explained by PG opt-in conditions; the remaining seven required the second
documented conformance flag. They were not stale test names.

A broad root invocation of `vitest list packages scripts/lib` also discovered
tests inside the ignored `.cache/research/.../packages` tree and failed on that
external checkout's missing dependencies. Explicit `--dir packages` and
`--dir scripts/lib` collection succeeded. This is local root-discovery fragility;
it is not evidence that the normal workspace-scoped `npm test` fails on a clean
checkout. Use explicit maintained roots in review/selection tooling.

**Keep:** native conformance, fencing/closure, original-reply continuation,
UNKNOWN, cancellation boundaries, shared-volume deletion and real process-level
recovery evidence. Source-string search alone misclassified several tests that
actually inspect generated fixtures or verify build-input boundaries.

**Consolidate after a schema baseline:** old model/Turn/archive/Fork conversion
tests and their historical fixture builders. Remove obsolete experimental runners
with their callers. Prefer executing a shared production component directly over
retaining a test-only production wrapper when it adds no semantic boundary.
Do not delete tests merely because their names or protected failure cases are old.

An apparent unused upload-staging registry was checked and **retained**: it is
called by the fixed Guest input-file path, which was outside the ten trusted-role
bundle roots. This illustrates why an import graph alone cannot authorize cleanup.

## Release decision matrix

| Change | Current reviewed boundary | Next step |
| --- | --- | --- |
| Presentation-only Web | Existing scoped operator; automatic CI classification overbuilds | Retain current scope; align policy in #33 after discussion |
| Ordinary Tool implementation/definition | Existing Tool-host scope and Kafka catalog; accepted calls have a drain contract | Retain scope; no Worker or API restart implied |
| Provider transport/model catalog | Existing dedicated scope with explicit contract/config checks | Retain; remove completed conversion exceptions only with baseline proof |
| Selected API, model gateway, activity-view or decoder files | Narrow explicit scopes exist | Broader coverage needs role/dependency/config tests |
| Resource manager, completion receiver, arbitrary provider mechanics | Separate roles, but broad build/config/default deployment paths | Resolve R02/R04/R05 before declaring general independent replacement |
| New cluster of an existing provider | Startup-oriented configuration today | #31 design/implementation; not a current no-restart capability |
| New persistence strategy/provider | Cube dependency and native constraints remain | #30 plus explicit adapter acceptance |
| Pi/Guest wire format, Kafka/schema/storage ownership | Real coordinated producer/consumer and recovery contract | Keep matched publication of affected participants and required drains |

Compatibility here means participants implementing the **current agreed protocol**.
It does not mean retaining old development-version readers indefinitely. Shared
protocol types and PG authority are intentional dependencies, not defects to remove.

## Verification and limits

- Documentation check: 40 files passed. Additional relative-link inspection:
  43 current guides, no missing targets.
- Static role bundle descriptions: ten entrypoints; no bundle executed.
- Pure release-impact examples reproduced the ten-image fallback above.
- Synthetic startup loader: three irrelevant-to-API Worker configuration removals
  each rejected; no service connection attempted.
- Helm rendering only: root chart version changed 9/11 Pod templates. The first
  scratch experiment accidentally changed the child dependency version too and
  failed schema validation; that invalid comparison was discarded and rerun with
  only the root version changed.
- Focused tests: **76 passed, 0 failed, 0 skipped**, across eight files covering
  release impact/manifests/replacement, Guest input identity, activity/retention,
  control dispatch and Worker Tool proxies.
- Fault inventory: 430/430 collected targets, no duplicate mapping. Collection
  used a non-listening synthetic PG URL solely to expose conditional test names;
  it did not execute those PG cases or establish database correctness.
- No image builds, model requests, runtime replacement, live chaos, node-loss or
  large-image experiments. Existing serving resources were not touched.

Sanitized machine-readable results accompany this report in
[the evidence summary](repository-decoupling-review-20261112.json). Detailed local
collection logs and temporary render/bundle descriptions are under
`/tmp/pma-review-20261112/`; they are not a required artifact for a clean checkout.

## Proposed order for discussion

1. Agree R01's control-effect authority boundary and R02's role-specific startup
   contracts. Preserve necessary PG mutation checks and existing Session fencing.
2. Narrow build inputs and separate current maintenance from completed cutovers.
   Correct current docs; establish the schema-baseline cleanup scope explicitly.
3. Use the reviewed role/contract matrix to implement #33 and prove limited
   replacements. This does not require perfect decoupling of every package first,
   but each enabled scope needs a complete verified boundary.
4. Implement #30/#31 as their own persistence/registration slices; they are not
   prerequisites for already independent Web or ordinary Tool updates.

The review is complete; the broader release optimization is deliberately not
implemented because the owner requested discussion of remaining coupling first.
