# Maintained backlog

## Image service rejection details — in progress

Preserve bounded provider error messages, codes, parameters and moderation
stage/categories in the existing Tool error text, so the Agent can explain a
refusal. Keep malformed/non-JSON responses generic, redact credentials and image
data, and bound error-body reading. Preserve cancellation, uncertain outcomes and
the one-request policy. Verify through the client and Tool boundary, then deploy
only the Control Plane using ADR-0276's quiescence procedure.

## Answer copy action alignment — completed

Place the completed answer's copy button in the same footer row as “从此对话开始”.
Preserve the full copy payload when a long answer spans virtual rows, without
duplicating its button in the text fragment. Desktop/mobile alignment, clipboard
content, 234 tests and the full browser/queue/history-layout gate pass. Web-only
`answer-copy-20261028` is deployed (Helm 120). Read-only live inspection confirms
the footer placement and no horizontal overflow; all 28 backend Pod identities,
the machine allocation and 27 configuration hashes are unchanged.
Two unrelated fixture-initialization timeouts are retained in the private evidence;
the complete gate passes on repeat. Added resource-failure diagnostics, without
claiming to have repaired that intermittent fixture-loading issue.
Evidence: `deploy/production/runtime/release-evidence/answer-copy-20261028/`.

## Interrupted assistant text in model context — completed

[ADR-0283](adr/0283-interrupted-assistant-text-context.md) implements preserving
cancelled visible text as assistant context with a short interruption marker.
Keep the raw aborted Entry and use Pi's context-only edit mechanism so requests,
recovery and compaction agree. One settled edit may duplicate that text once;
there are no new per-fragment PG body writes. Native recovery/compaction and real
GPT/Flash encoding checks pass. Matched `interrupted-text-jose-20261028` is deployed;
four real same/cross-model cases, full Cube and native Worker/Control Plane recovery
pass. Large-image cold recall and final asset preservation also pass.
[Delivery evidence](reports/interrupted-text-delivery-20261028.md).

- [x] Prove pinned Pi context/compaction behavior and current GPT/DeepSeek encoding.
- [x] Implement authorized settlement, idempotence and bounded cold preparation.
- [x] Verify cancellation/recovery/compaction/model-switch behavior and publish.

## Tool settlement presentation — completed

Move the error line from the whole activity group to the failed Tool alone.
Verify that success, failure and UNKNOWN settlement replace disposable previews
with the final result and ignore late preview updates. Existing native empty-output
and parallel-Read checks pass; Tool execution policy is unchanged. Web-only
`tool-settlement-053f6582` is deployed (Helm 118). Read-only live inspection
confirms one failed Tool among 22 cards receives the only red marker, with no
settled preview remaining; backend/Workspace identities are retained.
[Evidence](reports/tool-settlement-presentation-20261028.md).

## Tool group display correction — completed

Correct the toolbar to control only outer Tool-group expansion. Restore individual
Tool rendering and preserve manual detail/text choices. Constrain long output to
its code block after reproducing a 53,171 px overflow in a 710 px pane. Desktop
and mobile browser checks pass. Web-only `tool-groups-40bbf76f` is deployed
(Helm 117); live group/width checks pass with backend identities retained.
[Evidence](reports/tool-group-display-correction-20261027.md).

## Retry notices and Tool disclosure — completed

Merge each consecutive retry sequence into one updating line, consistently in
live and loaded history. Add one toolbar action for all Tool input/text-result
disclosures, retaining individual controls and image previews. Preserve all
native events and request behavior. Browser, 22 geometry cases and the actual
8 MiB PG/API/SSE composition pass. Web-only `retry-tools-3083d24d` is deployed
(Helm 116); actual page controls pass and backend/Workspace identities are retained.
[Evidence](reports/retry-tool-display-20261027.md).

## Manual live-tail return and snapshot/live Tool grouping — completed

Automatically resume live following when manual scrolling exhausts the latest
canonical page; preserve anchors and read intervening pages first. Continue the
snapshot page identity through new live Tools so grouping matches reopening.
Targeted tests, 20 browser geometry cases and the actual 8 MiB PG/API/SSE composition
pass. Web-only `live-tail-744c1cd6` is deployed (Helm 114). Both real-page manual
return gestures pass; all 28 backend Pod identities, machine allocation and 27
configuration hashes remain unchanged.
[Evidence and separate provider findings](reports/live-tail-and-model-latency-20261027.md).

## Native model continuation and phone UI withdrawal — completed

[ADR-0282](adr/0282-native-model-websocket-continuation.md) adopts Pi's native
WebSocket delta/cache behavior through the existing Worker Model Gateway. New
request metadata stays outside the provider payload, preserves per-request
sampling and budgets, and cannot invalidate context-prefix matching. Separate
incarnation/conversation/purpose identities and cleanup retain native cancellation
and storage ownership. Protocol, transport, recovery and bounded-flow tests pass;
actual Luna + Worker + installed subscription proxy recalls an image through
one full request and later deltas. Deployed as `continuation-5f-final`, Helm 115,
schema 202. Native upstream WebSockets are enabled in both provider accounts;
the maintained operator reapplies this setting on publication. Two different
Workers pass cold opening and continuation. About 3.11 MB becomes 19.8 KB per
request, with only 3.45 MB total actual provider transmission across three requests.

Remove the cloud-phone picker/component, styles and translations as requested.
Retain the alternate executor port/operator API and readable historical images.
Browser checks and original asset preservation pass. [Delivery evidence](reports/model-continuation-delivery-20261027.md).

## Very large cold visual context — investigation remains

The owner accepts occasional manual `/compact` for now. Keep native automatic
token-based compaction; do not add a byte-triggered policy without a new decision.

The active long conversation repeatedly sends a context containing 25 images:
79.6 MiB raw / 106.1 MiB base64 before other context. The current proxy HTTP path
resends full uncompressed JSON upstream and creates an upstream connection per
request. Timings show roughly 200-second first responses, four event-idle timeouts
and confirmed TLS EOFs. Cache token hits do not save upload bytes. ADR-0282 adds
native incremental continuation and payload-free Gateway size/phase timing.
Normal native continuation is deployed and measured end to end. Approximately
113 MB cold-input probes have not completed successfully; this does not invalidate
the measured normal-size delta path. Proxy-to-provider upload/queue timing remains
unmeasured; the proxy's outgoing
compression restriction remains. Do not silently remove images, force compaction,
or invent another durable context authority. These findings do not establish that
all delay is in the proxy. [Investigation](reports/live-tail-and-model-latency-20261027.md).

## Historical top-edge loading — completed

Read-only inspection of galgame finds four visible-history pages taking roughly
35–50 ms each, but a fresh direct jump/rapid drag to the top can issue no request
until another wheel event. Entering frozen history returns before the new state
is visible; a guarded anchor adjustment can also consume the only scroll event.
Recheck the older edge once after history/layout state settles, respecting the
existing in-flight/error gates and bounded page window. The composed browser test
must reach the edge without clicking Load Earlier or sending a second gesture.
The source repair, 8 MiB and 1 GiB composition pass, including the offscreen-anchor
correction; all 17 stream/layout cases also pass. [Evidence](reports/history-edge-repair-20261027.md).
Deployed Web-only as `history-edge-92f0d1f9` (Helm 113). Read-only live tests of
galgame confirm automatic fetching after all three fast-edge gestures; backend,
machine and configuration identities remain unchanged.

## Long-conversation layout stability — completed

The owner reported large gaps that disappear after scrolling and uneven Session
opening after virtual-history delivery. Read-only browser sampling reproduces
transient gaps up to 409 px; an isolated production-component fixture also
reproduces persistent gaps/overlaps after trimming a live window. Keep the
existing bounded pages and native history contracts. Retain valid row-size
measurements across eviction, synchronize dynamic sizes/positions before paint,
and reset presentation ownership on Session switches. Verify width changes,
Tool expansion, live growth/trim and reading anchors pass the new geometry check.
The real PG/API/browser composition passes with 1 GiB, four resident pages and
15.5–15.7 MiB retained heap. A persistent-footer append case is explicitly followed
without interpreting layout adjustments as reader gestures; bookmarks wait for
their target DOM node. [Repair evidence](reports/conversation-layout-repair-20261027.md).
Deployed Web-only as `history-layout-8155cc9e` (Helm 112). Real Luna streaming,
three Tool calls and existing-conversation inspection pass. All 28 non-Web Pod
identities, the original machine allocation and 27 configuration hashes remain
unchanged; owned test resources are cleaned.

## Subagent workspace and scheduled inputs — completed

ADRs [0280](adr/0280-workspace-scoped-subagent-contract.md) and
[0281](adr/0281-scheduled-session-inputs.md) are deployed as `schedules-08063299`,
schema 202/catalog v3. Workspace-scoped direct/workflow delegation shares one
capability contract; null removes workspace access and ephemeral remains Linux
compute on a shared Volume. Device coordination stays with Agents.

Current PG plans feed ordinary Run admission atomically, using one deadline wait,
notification hints and a 60-second fallback. The root schedule Tool and direct Web
management are connected. Every occurrence is a new Run; queued timer work does
not intercept steer/follow-up or active compaction. Source/calendar/PG/browser
checks, 375 fault cases, actual 10,000-plan admission and real Luna/Cube/Android
recovery acceptance pass. Original Sessions, images, files, accounts/configuration
and running applications are preserved. [Delivery evidence](reports/scheduled-inputs-delivery-20261026.md)
and [behavior/API](SCHEDULES.md).

Fleet execution and mixed Kafka/Projector saturation remain unmeasured; the
admission benchmark measures real PG Run creation and API responsiveness only.
They remain part of the existing capacity backlog, not a 10,000-Agent claim.

## Cloud Android execution target — completed

Owner-directed October 27 scope: withdraw the phone entry/picker and screen
controls from Web, deleting unused component/styles/translations. Retain the
execution-target abstraction and operator API; keep historical images readable.
The maintained Android acceptance uses API binding/screen reads and asserts that
the product has no phone entry.

[ADR-0279](adr/0279-android-execution-targets.md) was initially deployed as core
`android-a37491f4` (schema 201/catalog v2) and device `android-7aa30c34`.
Idle coding Sessions can bind one operator-provisioned Cuttlefish device. Six
root-only tools reuse ordered Session dispatch, boot-scoped Kafka replies and
existing screenshot storage. No independent device scheduler or result ledger.

Real Luna exercised every tool and read Chinese input; the browser bound the
device, rendered stored screenshots and refreshed its screen. No Cube VM was
allocated by those phone operations. Persisted settings/files survived a real
Pod/guest restart. Native input/Stop/Worker-and-Control-Plane recovery and Cube
coding/Preview/persistence checks pass. Existing accounts, Sessions, images,
Workspace bytes and applications were retained. [Delivery evidence](reports/android-execution-delivery-20261026.md).

The implementation corrected a missing JSON request header in browser binding,
OnDelete readiness/Pod creation waits, direct secret file mounts and the dedicated
Control Plane-to-executor network route. The browser acceptance now waits for an
enabled action and loaded selection instead of racing initial page loading.
Pure-phone Sessions, physical-phone apps, APK installation, camera tools,
automatic allocation/pools and multi-node placement remain later slices.

## Request failure wording — completed

Replace technical retry/native-task prose with localized user-facing copy.
Generic native failure does not prove a network connection failure; keep specific
Tool/timeout explanations and the original diagnostic data. This is a Web-only
presentation change; native retry/execution behavior and public schemas stay the same.
Deployed through the scoped Web path as `retry-copy-93c4d47b` (Helm 108).
All 222 scoped tests, browser presentation/queue checks and the single-image scan
pass. The deployed Web artifact renders the exact retry/failure payload correctly
in an isolated browser with synthetic API/SSE responses; no failing model request
or business mutation was manufactured. All non-Web Pod/container identities are
unchanged and 28/28 Pods are ready. Original diagnostics remain available through
the existing data; the Web maps known generic failure codes into localized copy.

## Long conversation presentation — completed

The owner approved [ADR-0278](adr/0278-windowed-conversation-presentation.md).
Read messages within a Run using indexed native positions and byte budgets;
retain only a bounded browser working set. Tree/search jumps must seek directly,
and export must stream without a whole-history browser Blob. This changes only
presentation reads, not model context, execution or history ownership.

Source and composed API/browser checks pass, including 1 GiB of native test
history and bounded browser residency. [Delivery evidence](reports/conversation-history-delivery-20261026.md)
records measurements and corrected failures. Deployed as `history-window-19c24570`,
schema 200; real Luna/Cube/browser/Stop/recovery acceptance and original-asset
reconciliation pass. Owned test resources are physically cleaned up.

## Model waiting and input commands — completed

[Revised proposal](reports/slash-commands-plan-20261025.md) covers provider-event
waiting, read-only `/usage` and input-driven manual `/compact`. Running compaction
must reuse the current Run and Pi's native Task/summary placement; the earlier
idle-only restriction is withdrawn. Per-task request binding, atomic command
identity and recovery are covered by public-SDK contract verification. Cold admission
uses a typed initial operation in the existing Run queue. The owner approved
[ADR-0277](adr/0277-model-event-waiting-and-conversation-commands.md) is deployed as
`commands-514e2b0f`, schema 199. [Delivery](reports/conversation-commands-delivery-20261026.md)
records composed Worker tests, real browser/Luna compaction, native input/Stop,
Worker and dual-process recovery, physical fixture cleanup and preserved assets.
The old header policy has been replaced by connection and model-event budgets.

## Scoped Control Plane publication

The owner approved [ADR-0276](adr/0276-scoped-control-plane-releases.md).
Ordinary Tool changes should publish only the Control Plane, retaining Workers,
Cube and running VMs. Browser update prompts are explicitly out of scope.

Deployed as `control-final-35d715ae`. [Delivery evidence](reports/control-plane-release-delivery-20261025.md)
records quiescence/failure coverage, positive old-owner closure and real active-Run
continuation. The original applications and all user assets are preserved; owned
fixtures are cleaned up. This first scope is one Control Plane without an HPA and
ordinary Tool code; broader runtime/ownership changes still require matched release.

## User-facing image presentation

The owner approved [ADR-0275](adr/0275-user-image-presentation.md): an explicit
`show_image` Tool for existing files, with images visible outside collapsed
execution details. Generation and display share canonical image content and one
browser component; old executor-supplied preview metadata no longer controls it.

Delivered as `show-image-1f7a950e`. [Evidence](reports/show-image-delivery-20261025.md)
records real Luna/Cube/browser acceptance, retained display after source deletion,
physical fixture cleanup and preservation of original Sessions and applications.

## Explicit image generation

[ADR-0274](adr/0274-explicit-image-generation-tool.md) is deployed as
`image-tool-0bac4e97`. [Delivery](reports/image-tool-delivery-20261025.md) records
real path/recent-context image calls, alpha, saved files, live/cold display,
375 fault cases, shared image admission and physical test cleanup. Existing
Sessions, Workspaces and applications are retained. The provider's implicit
image injection was disabled, and future matched upgrades reconcile that policy.

The owner subsequently confirmed successful image generation in the existing
conversation. This is user-reported acceptance; the earlier delivery report
retains the actual results of its own attempts.

Only unfinished work for the PostgreSQL + Kafka + Pi SDK + Cube Volume
architecture belongs here. Implemented contracts live in the
[architecture](ARCHITECTURE.md), [current ADRs](adr/README.md) and versioned
acceptance evidence. Superseded plans and completed-task journals remain in Git.

[Cube-owned finite elastic retention](adr/0272-cube-owned-elastic-retention.md)
is delivered as `elastic-retention-03ce2f23`, schema 197. The
[delivery record](reports/elastic-retention-delivery-20261023.md) records source,
361 fault cases, 12-image evidence, controller-offline default-window expiry,
retained-file/native recovery and confirmed cleanup. Dedicated-machine recovery
was subsequently delivered under ADR-0273 below.

The [composer and native pending-queue delivery](reports/composer-queue-delivery-20261023.md)
is deployed as the Web-only `composer-4c31ccfc`. Configurable Enter, draft-aware
send/Stop, compact inline queue actions and stopped-input return pass browser and
real Luna/Cube checks. Existing backend, machine, files and configuration remain
intact; the temporary acceptance resources are physically cleaned up.

The [initial-input handoff repair](reports/input-handoff-delivery-20261024.md)
is deployed as `input-handoff-2a5a2ffd`, schema 198. Early SSE execution no longer
renders placeholder prose as user input. Background-service instructions retain
readiness evidence without mandating a separate Bash call. Source/browser and
real native queue/Stop acceptance pass, with retained machine/Workspace/history
and completed fixture cleanup. No periodic progress-narration policy was added.

The [Preview presentation delivery](reports/preview-answer-delivery-20261024.md)
is deployed as `preview-answer-16f8f8b5`, schema 198. Named answer links replace
separate application cards; technical data stays in Tool details. Source/browser,
HTTP dependency, artifact and real Luna navigation checks pass. Both existing
applications and all original assets/configuration are preserved; the owned
acceptance resources are physically cleaned up.

## Resource intent and dedicated-machine recovery

[ADR-0273](adr/0273-resource-intent-and-machine-recovery.md) is deployed as
`resource-intent-cad5487a`, schema 198. [Delivery evidence](reports/resource-intent-delivery-20261023.md)
records preserved pause, recovered creation replies, confirmed physical
replacement, inherited ephemeral-scope retention and native continuation. All
original files/configuration/history checks and owned fixture cleanup pass.
The maintained single-controller replacement procedure remains stop-old / owner
closure / start-new; overlapping-owner rolling updates retain their separate
backlog below. Cold replacement preserves Volume bytes, not process memory or
arbitrary system-disk changes.

- [ ] Promote compute-only retirement for full matched upgrades into a maintained
      operator command. The current release runner still requires empty native
      inventory. Quiesce resource controllers before closing desired-running
      allocations, confirm the recorded node's absence, and preserve user intent
      and Workspace bytes. This delivery used a scoped cold administrative
      sequence; public machine Release must not be used for this purpose.


The [September 15–17 audit](reports/repository-audit-20260915.md) is complete:
maintained-file review, paid combination tests, process faults, browser paths,
latency analysis, isolated load gates and scoped cleanup. Its bounded measurements
do not establish enterprise-scale capacity or physical multi-node HA.

The [September 30 review](reports/repository-review-20260930.md) is complete at
`5fd6159f8a0ec0cc5d4ebc0dc24071c29b82028d`. It adds eight confirmed findings,
three decisions to discuss and scoped cleanup candidates. The subsequent
[repair record](reports/repository-review-repair-20261001.md) records all eight
confirmed repairs, the accepted deletion/interruption decisions, bounded cleanup
and passing combined verification. The subsequent
[authority and Cube execution implementation](reports/cube-execution-authority-20261001.md)
and the [production cutover](reports/cube-execution-rollout-20261001.md) are
complete. The owner confirmed dsh-cloud is retired; it no longer constrains
PiCloud deployment. Remaining operational limits are listed below.

The repeated Cube template-cleanup timeouts are resolved under
[ADR-0233](adr/0233-template-cleanup-node-routing.md): cleanup used obsolete Pod IPs
instead of current addresses for the same stable node. The
[deployed repair](reports/template-cleanup-20261007.md) removes 55 unused templates
and their artifacts, preserving all four current templates and historical UNKNOWN
VM records. The bounded release-time cleanup budget remains for unavailable nodes.

## Agent browser capability and application preview delivery

The owner subsequently authorized releasing the current development machine and
deleting its entire Workspace for this upgrade; preserve conversations, accounts,
provider/model settings and credentials. After the upstream proxy software changed,
[ADR-0271](adr/0271-local-upstream-proxy-configuration.md) adds a shared operator
command for the shared local upstream address.

- [x] Synchronize active host/model/Cube proxy settings to port 12450; verify
      repeat application, retained Worker/Relay identities and actual routes.
      The browser matched release is `guest-browser-bd03f7a6`, schema 197.

The owner approved [ADR-0270](adr/0270-guest-browser-and-tool-result-actions.md).
Source implementation adds pinned Playwright/Chromium and CJK fonts in the guest,
bounded same-commit Tool metadata, visible collapsed-group preview actions and
model-visible authenticated paths. Image checks and real Luna guest interaction,
screenshot vision, live/cold preview links and actual application navigation pass.
The [delivery record](reports/guest-browser-delivery-20261022.md) separates source,
artifact and live evidence, including the retained initial failures.

The October 22 read-only investigation confirmed that the previous guest image did
not provision a browser/automation stack. A live Agent's executable/package checks
found none; its reported syntax, logic and HTTP checks therefore do not establish
actual UI interaction. The published application returned HTTP 200 through
the maintained preview connection. The subsequent authorized machine release and
Workspace deletion preserve its conversation, not the deleted application files.

- [x] Decide the maintained guest browser/automation capability and its pinned
      image dependencies, so front-end work can obtain real interaction and
      screenshot evidence inside the Tool Sandbox. Host-side browser acceptance
      does not mean a guest browser exists. Keep execution in Cube and use native
      file/image tools; no separate browser service is required by this finding.
- [x] Preserve structured native Tool-result display metadata on the live path.
      The old `prepareToolPresentation`/`resolveDurableDisplay` emitted only output
      text, dropping `details.previewPath`. Canonical history retains the details,
      so refresh and live delivery disagree. Use the existing commit-reference
      mechanism and PiCloud-owned output shape; do not duplicate native history
      or add a preview-only decoder workaround. Cover live and cold render paths.
- [x] Keep successful application links visible independently of collapsed Tool
      groups. Real conversation-data rendering produces no preview link in the
      default collapsed Turn, one from its expanded canonical Tool, and none
      from the live text-only Tool. Preserve compact invocation details while
      exposing the result action, and test this through the normal conversation
      view rather than only rendering an isolated Tool card.
- [x] Return the actual platform preview path in useful Tool-result text as well
      as display metadata; do not tell the model that a link was already rendered
      when the executor can only confirm publication. Verify any resulting link
      against the existing authenticated preview route, without inventing URLs.
- [x] Complete browser image/real native-Tool interaction, screenshot/cancellation
      checks and Luna live/cold preview navigation; deploy matched artifacts after
      the owner's authorized machine/Workspace deletion and confirmed physical purge.
- [x] Finish native input/streaming recovery regression and the final protected
      account/configuration/credential comparison, retaining failed samples.

## Ultra collaboration and child-task visibility

The consolidated proposal follows Codex's single effort picker and native Pi
instruction sections: Ultra maps to provider Max plus proactive delegation;
non-Ultra retains tools with explicit-request-only instructions. No separate
collaboration selector or effort-based execution prohibition is proposed.
[Findings and proposal](reports/subagent-wait-review-20261021.md)
show a long-running child and successful final delivery, with additional model,
review and environment-validation work; no lost reply was established.
The features are deployed in `runtime-capabilities-5d39828d`, schema 197.
[Delivery evidence](reports/runtime-capabilities-delivery-20261021.md) records
source checks, real guest networking, native Max/Ultra policy and child/browser
behavior, plus catalog-only acceptance with retained Worker/Run/lease identities.

- [x] Restore the approved guest-egress configuration, validate the actual guest
      route, and expose known network capabilities through the existing context path.
- [x] Implement one selected/effective profile resolver and native delegation
      instruction section; preserve accepted-Run recovery and parent/child inheritance.
- [x] Improve parent-visible child progress using existing relationships and
      disposable HTTP/SSE: one compact line, opt-in details, no forced scrolling,
      with terminal precedence and reconnect handling.
- [x] Complete the separate execution-owned tool-catalog slice using public Pi
      registry/configuration, full catalog snapshots and full effective model
      tool lists. Preserve active calls during withdrawal; add no cache-specific
      tool-search/append protocol or per-request database lookup.
- [x] Verify actual request effort/tools/instructions, explicit delegation at
      non-Ultra, Ultra behavior, queue/recovery/Stop, catalog changes and live
      acceptance before the relevant matched releases.
- [x] Release the existing development machine and its entire Workspace with
      the owner's explicit authorization; confirm VM absence and storage purge
      before matched deployment. Preserve accounts, configuration and credentials.

## Compatible Control Plane replacement

- [ ] Close the rolling Control Plane warm-Workspace admission gap found by
      runtime-catalog acceptance: a new Pod can be Ready while a retained VM
      still points to a removed old Pod whose PG owner lease has not expired.
      A new Run can receive a pre-execution sandbox reservation error. Preserve
      owner fencing and physical recovery evidence. For the supported single
      Control Plane compatible update, stop the old Pod, wait for its PG lease
      closure/expiry, then start/adopt before readiness (ADR-0269). General
      overlapping-controller admission remains a separate handoff slice.

## Run status presentation

- [x] Keep phase and connection/update-delay warnings visible; move activity and
      path/guest confirmation ages into collapsed diagnostics. Verify browser
      disclosure, reconnect, stale observations and the deployed UI. Observation
      transport and runtime authority remain unchanged.
- [x] Publish the UI through the existing scoped release operator's Web image
      scope, preserving the current development machine and backend artifacts.

[Delivery evidence](reports/run-status-presentation-20261021.md) records passing
browser/Luna/Cube acceptance, one-image publication and confirmed fixture cleanup.

## Scoped release and runtime model catalog

[ADR-0267](adr/0267-scoped-releases-and-model-catalog.md) is deployed on schema
196. [Delivery evidence](reports/component-release-20261021.md) confirms provider
and catalog updates during native work, unchanged Worker/VM/lease identities,
frozen old/new Run parameters, original configuration and physical cleanup.

- [x] Validated deployment catalog, frozen Run capabilities and data-driven menus.
- [x] Component provenance, guarded independent operations and CI checks by impact.
- [x] Initial matched cutover, real independent updates, native continuation,
      model capability checks and fixture cleanup.

## GPT-6.1 Sol catalog refresh

The [ADR-0191 amendment](adr/0191-gpt6-model-catalog.md) is deployed as
`gpt61-sol-8827da09`, schema 195. Standard-mode GPT-6.1 Sol text/function/vision/search,
four native Tool Runs, Luna regression and physical cleanup pass. Routine tests
still default to Luna; accepted model history and original accounts/configuration
are preserved. [Delivery evidence](reports/gpt61-sol-20261021.md) separates source,
artifact and real-model results, including corrected compression/Vite dependencies
and the disposable image-store capacity failure.

## Effective Fast routing

- [ ] Establish the actual tier on the subscription route before certifying Fast.
      The current PiCloud payload uses `fast`, which the pinned CLIProxyAPI
      Responses translator filters; Codex's inspected request spelling is
      `priority`. Both a real `fast` request and a separate `priority` request
      nevertheless reported `default`. Trace outbound transformation, raw provider
      reply and account support; do not infer acceleration or premium billing
      from HTTP 200 or latency. Then correct the existing adapter and require
      effective-tier acceptance, keeping Standard requests unchanged. This does
      not block the verified Standard-mode GPT-6.1 Sol rollout.

## Resource/interaction release acceptance

The [combined review](reports/resource-interaction-review-20261020.md) and all six
source repair slices are implemented and deployed as `resource-repair-1cdccb80`,
schema 194 / Session topic v18. The [delivery record](reports/resource-interaction-repair-20261020.md)
contains the 16 findings, query reductions, native/PG/RF3 contracts and actual
shared/ephemeral child, long-work, terminal, supervisor, upload, browser and Cube
acceptance. Two additional live findings—cancelled upload stream errors and
refused WebSocket shutdown sockets—are repaired. Original configuration
fingerprints and confirmed physical cleanup pass.

The unchanged combined 6/6/25 MB Tool-image and cold-recall repeat now passes.
The first post-switch sample completed every request but answered one chart
ranking incorrectly. Original-byte integrity and controlled recovery/provider
conversion checks passed; that failed answer and the earlier upstream timeouts
are retained separately from the subsequent passing repeat. All six repair
slices and their release acceptance are complete. The independent Cube snapshot
root-cause investigation below remains open.

## Native model request / response review

The [October 19 review](reports/model-request-response-review-20261019.md) completes
this main-message branch. MR-01–04 and the owner-decided removal of the total
Agent duration limit are implemented under
[ADR-0263](adr/0263-model-response-and-work-lifetimes.md), deployed as
`model-runtime-058925bb`, schema 192. One Models adapter preserves native retry,
phase identity and completed hosted content; the Gateway owns transport only.
Owner-bound grants replace the fixed TTL, and Worker retirement is independently
bounded. No additional queue, checkpoint authority or compatibility path remains.

[Delivery evidence](reports/model-runtime-repair-20261020.md) records source/artifact,
real long-work/handoff, hosted/native/browser/child/outage/image/full-Cube gates and
confirmed physical cleanup. Original accounts/configuration/credentials are unchanged.
The first child-recovery sample failed after the model issued a second distinct
launch; native Kafka evidence and the unchanged passing repeat are retained. This
slice does not promise effect deduplication across different model-generated tasks.

## Replacement Worker → Pi Harness recovery review

The [October 19 review](reports/worker-harness-recovery-review-20261019.md) at
`e131a2ea` completes this hop with 110 existing tests, seven isolated behavior
cases and six cost samples. Indexed latest-head/context reads remain independent
of old history in the fixture; native family continuation/Stop preserve ownership,
input identity and unsafe Tool non-replay. The review itself changed no runtime.
The approved [repair plan](reports/worker-harness-recovery-repair-plan-20261019.md)
and [ADR-0262](adr/0262-native-recovery-read-lifetimes.md) are deployed as
`native-recovery-8c00826a`, schema 191. [Delivery evidence](reports/worker-harness-recovery-repair-20261019.md)
records source/artifact, native/browser, actual child Worker recovery, Control Plane
outage, large-image cold recall and full Cube acceptance. Physical cleanup and
the original configuration/resource comparison pass.

- [x] WHR-01 / P2: separate bounded native-read pool and existing ordered
      closure/same-Run recovery for typed transient failures; use the existing
      PG queue timestamp for a five-second delay.
- [x] WHR-02 / P2: carry owner/read cancellation through startup, SQL and image
      hydration while preserving native Stop settlement and acknowledged commits.
- [x] WHR-O1 / P3: reattach the original child Submission/configuration without
      prompt lookup or another configuration commit. Batch 257 active child views
      in three metadata queries; preserve identity and the family effects barrier.
- [x] WHR-O2 / P3: evaluate the public operation boundary. Pi's hooks start after
      context construction, so retain per-decode validation/reuse. Image-read
      cancellation is fixed; no global cache or private Pi patch is introduced.
- [x] WHR-O3 / P3: index pending Submission status/ID for custom and actual named
      generic plans. The 10,000-completed/two-queued fixture examines at most two
      matching record rows, retaining all completed receipts.

The final bounded short-text family sample prepares 1/8/32/128 children in
0.154/0.393/1.298/5.934 seconds. Pre-granted authority and synchronous PG projection
exclude failure detection, writer closure, Kafka and real model/VM response;
these are not full-failover or fleet-capacity timings.

## Kafka seal → Projector → PG closure review

The [October 19 review](reports/seal-projection-review-20261019.md) at `1d84ea59`
records 175 existing tests, five isolated characterizations and four query-cost
cases. Checkpoint, closure and release remain atomic in the tested rollback,
lost-return and concurrent-claim schedules. No runtime or deployment changed.

The owner-approved [ADR-0261](adr/0261-session-seal-projection-boundaries.md)
is deployed as `seal-projection-0de1fe7f`. [Delivery evidence](reports/seal-projection-repair-20261019.md)
records passing source/artifact and native/browser/child/outage/full-Cube gates,
retained failures and confirmed physical cleanup with original configuration
preserved. That release's image cold recall remained unaccepted; the current
recovery release passes the unchanged gate.

- [x] SPJ-01 / P2: bound projection acquisition and complete checkout, including
      cold reads and COMMIT waits, through the existing PG adapter.
- [x] SPJ-02 / P3: retire the exact old writer's live view after confirmed closure,
      including lost-return replay, without clearing successor state.
- [x] SPJ-O1 / P3: retain exact latest-sequence/hash proof using existing pending
      replay ranges; one pending delta now reads one matching header in the
      50,000-history fixture instead of 50,002.
- [x] SPJ-O2 / P3: reuse the transaction-local locked Run. The measured recovery
      path uses 19 business statements plus one budget statement, with one Run
      read instead of two; CAS/history/release ordering remain.
- [x] Complete the unchanged large-image cold-Worker recall gate on
      `native-recovery-8c00826a`. After the owner's proxy-node switch, 6/6/25 MB
      images are correctly recalled by a different Worker without Tools. Payloads
      and deadlines are unchanged; preceding response-header failures remain
      recorded separately and their underlying network cause is not established.

Replacement Worker/Harness bootstrap is reviewed and repaired above.

## PG Outbox → Kafka Session seal review

The [October 19 review](reports/seal-publication-review-20261019.md) at `596f9b92`
records 46 passing existing tests, six isolated characterizations and one existing
real RF3/PG integration case. Runtime and deployment are unchanged; fixture/type
corrections and the limits of substituted callback evidence are explicit.

The owner approved [ADR-0260](adr/0260-session-seal-publication-lifetimes.md).
Repairs are deployed as `seal-publication-8d9e7bc2`.
[Verification and delivery](reports/seal-publication-repair-20261019.md) record
passing source/artifact/live gates, retained upstream TLS/timeout samples and
confirmed cleanup with original configuration fingerprints preserved.

- [x] SP-01 / P2: bound publication PG acquisition/SQL and retirement waits using
      existing database facilities. Preserve immutable Outbox retries and drain
      old-generation work before replacement; do not bypass pending work by
      starting overlapping same-Session producers.
- [x] SP-02 / P2: join all transactions borrowing the consumer during its own
      background restart, including external Session seal writers. Preserve
      group/dispatch ordering; normal whole-Projector close already drains them.
      Callback tests establish disposal ordering, not a native crash or stale
      broker commit.
- [x] SP-03 / P2: invalidate an unreachable cached owner and rediscover under a
      bounded retry policy. This reproduces the previously deferred surviving-
      forwarder case; it is relevant to multiple Control Planes, not evidence of
      an outage in the single-process baseline.

The no-binding local seal uses six measured client SQL statements. Three authority
reads bracket distinct actions; no removal or replacement with a cache is proposed.
The subsequent [closure projection review](reports/seal-projection-review-20261019.md)
is complete; successor bootstrap remains the next focused walkthrough hop.

## Control Plane → PG expiry review

The [October 18 review](reports/control-plane-expiry-review-20261018.md) at
`3494ff92` records 50 passing existing tests and six isolated characterizations,
including explicit probe corrections. The review itself changed no runtime.
The approved repair is now deployed as
`control-expiry-c9d8112d`, schema 190.

The owner-approved [ADR-0259](adr/0259-control-plane-expiry-progress.md) is complete.
[Delivery evidence](reports/control-plane-expiry-repair-20261018.md) records source,
artifact, live recovery and physical cleanup, including original configuration
fingerprints and the unchanged upstream TLS sample.

- [x] CPE-01 / P2: bound Control Plane maintenance SQL/lock waits and prevent
      management expiry or an unrelated healthy Session from stalling expiry
      progress. Keep lock order, fresh PG-time checks and conservative ownership.
- [x] CPE-02 / P2: converge authoritative failed Workers into existing retirement
      even while their management heartbeat stays healthy. Preserve healthy idle/
      busy reconnect and exact Boot/Session closure; one expired Session must
      not retire its healthy Worker siblings.
- [x] CPE-03 / P2: select expiry work still needing closure admission so pending
      seals no longer monopolize the former ten-Worker window. Keep ownership evidence
      until ordered closure. The eleven-Worker repro is an expansion case;
      the current deployment has two Workers.
- [x] CPE-O1 / P3: remove all-healthy-Session work from ordinary expiry and reuse
      transaction-local locked facts. One expiry now uses 13 statements for
      1/8/64 Sessions; separate management scans add two reads. Normal and forced
      closure release eligible owners atomically; no orphan-cleanup replacement
      or competing cache is needed.

- [x] Required source/fault/transport gates, scanned matched release, live recovery
      and complete owned-fixture cleanup with original configuration preserved.

## Worker → PostgreSQL Session lease review

The [October 18 review](reports/worker-session-lease-review-20261018.md) at
`85eb2f07` records 123 passing existing tests, four isolated characterizations
and constant three-business-statement batch renewal. The review changed no runtime or
deployment. The owner-approved [ADR-0258 repair](adr/0258-bounded-session-lease-renewal.md)
is deployed as `session-lease-079dbddc`; [delivery evidence](reports/session-lease-repair-20261018.md)
records passing checks, real recovery/outage acceptance and confirmed physical
cleanup with original configuration fingerprints preserved.

- [x] WLR-01 / P2: enforce the active owner's last confirmed monotonic deadline
      independently of pending PG reads; bound database/pool/close waits. Keep
      cold-restore reauthorization and reject late revival; local expiry is not
      PG release, physical cleanup or successor authorization.
- [x] WLR-02 / P2: signal local failure/revocation before waiting for the PG
      Worker quarantine write. Bound persistence without bypassing eventual
      retirement/ordered closure; retain uncertain-publication failure semantics.
- [x] WLR-03 / P2: prevent one lock-busy Session from blocking all batched
      renewals. Distinguish unconfirmed/busy from rejected owners and never
      extend authority from skipped rows. Keep post-lock PG-time checks and
      test healthy siblings, expiry, closure, pool/network stalls and late replies.

- [x] Complete full source/transport/fault gates, scanned matched release, relevant
      Luna/Cube/recovery and Control Plane outage acceptance, configuration preservation
      and physical fixture cleanup.

## Projector → browser review

The [October 18 review](reports/projector-browser-review-20261018.md) at `5e6a381f`
records passing source/isolated-PG/browser checks and bounded reproductions.
It does not repair or redeploy the serving runtime. The subsequently approved
[ADR-0257 repair](adr/0257-browser-observation-and-buffer-boundaries.md) is
deployed as `browser-delivery-205e6ac0`;
[verification/release](reports/projector-browser-repair-20261018.md) records passing
source/artifact/live gates and confirmed physical cleanup. Original account,
model/provider configuration and credential fingerprints match the baseline.

- [x] PBR-01 / P2: align disposable SSE/browser observation revisions with
      same-Run writer replacement. Carry the existing fencing generation through
      public observations; reset old-generation state in both filtering layers.
      Retain scope/freshness checks, child/terminal behavior and same-writer cache resets.
- [x] PBR-02 / P2: bound slow-reader queued bytes as well as event count. Use
      existing snapshot resync on overflow, release counters on every exit and
      verify a periodically draining connection alongside a healthy viewer.
      The review proves 32 MiB of retained Tool input, not a production OOM.
- [x] PBR-O1 / P3: compact adjacent commentary appends with the same explicit
      message identity while preserving replacements, phases and message boundaries.
- [x] PBR-03 / P3: remove the obsolete 25 ms public-text coalescing claim from
      maintained architecture/streaming guidance. Native commits, recovery spans
      and browser animation are separate boundaries.
- [x] B4: required source/fault/transport/browser gates, scanned matched release,
      real same-connection Worker recovery and relevant live acceptance; preserve
      original configuration and confirm physical fixture cleanup.

## Session publication and whole-Run completion review

The [October 18 review](reports/session-publication-completion-review-20261018.md)
at `6b7bc02b` records the baseline. The owner-approved
[ADR-0256 repair](adr/0256-session-publication-and-completion-boundaries.md) is
deployed as `session-completion-6e74fd5b`;
[delivery evidence](reports/session-publication-completion-repair-20261018.md)
records passing source/artifact/live gates and confirmed physical cleanup with
original accounts, configuration and credentials preserved.

- [x] SPC-01: on normal `work_finished` replay, recover the exact persisted
      terminal/coverage after uncertain PG COMMIT return. Preserve unique events,
      identity/closure checks and successor fencing; do not add a terminal Outbox.
- [x] SPC-02: preserve trusted no-send refusal through the native Session Host.
      Let Pi handle `StorageRejected` without aborting siblings; keep uncertain
      ACK, post-ACK failure and producer fencing fatal. Add integrated Host tests.
- [x] SPC-03: rewrite RUN_LIFECYCLE and STREAM_DURABILITY around direct Session
      producers/native children and normal versus forced retirement. Remove
      obsolete ingress, unsealed counters and per-child claim/seal descriptions.
- [x] SPC-O1: reuse transaction-scoped locked Run data in normal completion;
      the fixture now reads the Run once instead of three times. Preserve version/transition
      checks and intermediate cancellation updates; add no cross-request cache.
- [x] SPC-Q1: synchronize transport fixtures with the control changes they are
      measuring and distinguish duplicate notifications from duplicate effects.
      The maintained RF3 suite passes 9/9, including intentional duplicate closure
      delivery. The baseline review retains its earlier 7/9 sample and diagnostic repeats.
- [x] Complete the required source/fault/transport gates, scanned matched release,
      relevant live acceptance and configuration/physical-cleanup verification.

## Worker → Pi Tool settlement review

The [October 18 review](reports/worker-harness-settlement-review-20261018.md) checks
the original Worker's result handoff into native Pi and its Storage commit.
Atomic final settlement and unsafe recovery pass; the findings below are not
implemented by the review and do not require a new execution/storage authority.
The owner approved repairs and chose native 50 KiB/2,000-line defaults in
[ADR-0255](adr/0255-native-tool-result-boundaries.md). The
[delivery record](reports/worker-harness-settlement-repair-20261018.md) records
`tool-settlement-20ac9696`, passing source/artifact/live gates and confirmed cleanup.

- [x] WHS-01 / P2: use Pi's native 50 KiB/2,000-line limits for coordination
      result admission, superseding the 256 KiB policy. Accepted JSON and multiline replies
      must remain complete; retain explicit oversize errors, fixed Tool limits,
      native hooks and the independent display budget.
- [x] WHS-02 / P2: skip sequence reads for body-less committed notifications and
      make `recordSequence()` read only metadata after eviction. Retain observed
      progress and ownership guards; sequence lookup must not download images.
- [x] WHS-03 / P3: validate final-reply content parts before marking a valid
      settlement. Cover text/native-image/packed-image boundaries and malformed
      parts using PiCloud schemas and existing protocol-failure handling. The
      review reproduces injected bad frames, not a normal malformed producer.

## Kafka replies → Worker callback review

The [October 17 review](reports/kafka-worker-reply-review-20261017.md) confirms
three Worker return-path issues with isolated probes and actual RF3 reassignment.
Normal duplicate/late handling and native Pi result ownership remain sound.
The [ADR-0254 plan](adr/0254-worker-reply-admission-and-settlement.md) incorporates
the owner's subsequent thin-admission decision. The repair is deployed as
`worker-reply-b1f67dba` after host KVM recovery. [Delivery evidence](reports/worker-reply-repair-20261017.md)
records passing repository/transport/fault and artifact gates, real Luna/Cube/
browser/recovery acceptance, retained failed samples and confirmed fixture cleanup.

- [x] KWR-01: include reply-consumer health in existing Worker admission and
      remove provider HEAD startup/periodic admission prerequisites. Pending
      waits retain the existing Tool/outer Run/cancellation bounds; no separate
      Worker outage timer, channel lease or PG health store is added.
- [x] KWR-02: distinguish validated execution receipt from attachment restoration.
      A failed image read or Stop during decoding must not erase known completion
      or falsely classify the sandbox as unavailable. Retain Run interruption
      with an accurate attachment failure reason, native abort precedence and
      canonical commit ownership without a durable raw-result cache.
- [x] KWR-03: resume same-boot reply consumption from completed in-memory delivery
      progress instead of replaying the retained prefix. Retain bounds/unsettled
      handler checks and keep Session Projector recovery semantics separate.

## Cube completion → Kafka replies and UNKNOWN continuation

[ADR-0253](adr/0253-tool-reply-uncertainty-and-continuation.md) is deployed as
`tool-unknown-791a6ed0`. [Acceptance](reports/tool-reply-continuation-20261016.md)
covers bounded UNKNOWN continuation, idle completion-process recovery, startup
Stop settlement, native input/dual-process recovery, browser/image/Read and full
Cube behavior. Source, transport, 256 fault cases and eleven artifact scans pass.
The owned Cubelet crash fixture required positively confirmed operator detach
before normal Volume GC could finish; the subsequent repair is described below.

## Cubelet restart and retained Volume evidence

The earlier ADR-0253 crash fixture needed operator-confirmed detach because
holder identity had already been discarded. [ADR-0265](adr/0265-volume-reference-recovery-evidence.md)
and the [deployed repair](reports/resource-interaction-repair-20261020.md) now retain
missing holder identities and reconcile them through closed allocation,
recorded-node absence and the existing POSIX detach receipt. Native race tests
and owned live node-restart/Volume cleanup pass.

Historical Unknown records whose identity was already lost still require positive
operator evidence. A missing probe, zero holder count or replaced metadata is
never sufficient. There is no remaining owned test Volume awaiting this cleanup.

## Guest → Cubelet result review

The [October 16 review](reports/guest-cubelet-result-review-20261016.md) is complete
against `06559532`, with isolated guest/PTY/native-driver evidence and passing
existing suites. It changes no runtime or deployed protocol.
The subsequent discussion and approved repair are recorded in
[ADR-0252](adr/0252-tool-receipt-and-ephemeral-preview.md). Source implementation
adds incremental display/reset semantics and terminal-aware previews. The
[delivery record](reports/tool-receipt-preview-repair-20261016.md) tracks source
verification and matched deployment/live acceptance. All source/native/
fault gates and eleven artifact scans pass. The owner-authorized Windows rollback
and reboot restored KVM; actual VM creation and all four new templates pass.
`tool-preview-325f0ebd` is deployed with Ready application workloads. Continuous
previews, one Control Plane replacement and receipt-only loss preserving the
result/background server/sibling process pass. Complete targeted/native-input/
browser/full-Cube acceptance subsequently passes. The empty-Session recovery
probe measured 30 seconds, explaining the old 25-second test deadline; the corrected
fixture retains all assertions and records actual recovery. Earlier external
AnyTLS-path failures remain a separate backlog item below. The release operator checks KVM device
availability on every Cube compute node before draining.
The Windows-local web-entry gap found after reboot is repaired with a standard
systemd socket proxy in the local WSL deployment adapter; direct Windows/Linux
HTTP checks and removal/reinstallation pass.

- [x] R16R-01: distinguish receipt-only transport failure from unfinished or
      unsafe execution. A complete valid result plus confirmed local settlement
      must not be discarded or trigger operation-cgroup cleanup solely because
      the reverse receipt failed. Preserve the bounded receipt, UNKNOWN for
      missing evidence and Control Plane lifecycle ownership; record the revised
      termination contract in an ADR before implementation.
- [x] R16R-02: bound encoded preview data at the guest transport boundary and
      remove repeated arguments/truncation text from observations. Preserve final
      native results and lossy HTTP/SSE semantics; test large/escaped output and
      ordinary final-result delivery. Deliver revision-bound edits plus bounded
      resets across every coalescing boundary; cover missing bases, reconnect,
      owner changes and final completion overtaking observations.
- [x] R16R-03: interpret CR/ANSI progress updates before forming display edits;
      current stripping concatenates successive progress labels. Evaluate the
      pinned headless terminal behind the preview port, keeping ordinary pipe
      execution and final result collection independent. Verify bounded parser
      overload, Unicode, split controls and actual guest/browser rendering.

## Cubelet → guest execution review

The [October 15 review](reports/cubelet-guest-execution-review-20261015.md) is complete
against `c3837bdb`, with existing suites and reproducible isolated evidence.
The owner-approved repairs under [ADR-0251](adr/0251-guest-attachment-and-execution-bounds.md)
are deployed as `guest-execution-5536fc73`, guest protocol 6. The
[delivery record](reports/cubelet-guest-execution-repair-20261015.md) covers passing
CI and live acceptance, first-attempt streaming uncertainty, the extra startup
failure during injected dual crash, preserved configuration and confirmed cleanup.

- [x] R15G-01: bound the final cleanup-helper Kill after its parent budget expires.
      Preserve UNKNOWN/unsafe outcomes, operation scope and Control Plane lifecycle ownership.
- [x] R15G-02: align custom Read path interpretation with pinned Pi and native
      Edit/Write, including alias/Unicode and ambiguous-name contract cases.
- [x] O15G-01: separate ordinary Tool attachment parameters from full VM
      initialization; remove unused recipe/seed fields through an explicit matched protocol change.
- [x] O15G-02: recheck expiry before issuing native Start; do not call an
      already-issued or ambiguously acknowledged Start definitely unexecuted.

## Projector → Cube handoff review

The [October 15 handoff audit](reports/projector-cube-handoff-review-20261015.md)
reviews `93635d37` and the exact pinned Cube patches. It preserves confirmed
dispatch-before-effect and UNKNOWN semantics. Source/isolated probes pass; this
review does not change runtime behavior or count as new live fault acceptance.

The owner approved [ADR-0250](adr/0250-cube-handoff-outcomes-and-runtime-admission.md).
[Repair progress](reports/projector-cube-handoff-repair-20261015.md) distinguishes
source changes, checks and matched delivery. D15H-01 is a pinned-Pi upgrade check;
no batch-position protocol extension is included in this repair.
The repair is deployed as `handoff-6ab91bb7`; source/native gates, full Cube,
native-input/browser/child recovery, configuration preservation and cleanup pass.

- [x] R15H-01: keep takeover failure notification independent of quarantine
      success; preserve lifecycle reconciliation and never replay committed Tools.
- [x] R15H-02: classify endpoint rejection code and effect evidence separately.
      Preserve definite pre-execution refusals; unknown semantics stay UNKNOWN.
- [x] R15H-03: make removed-VM admission and position cleanup share the native
      lifecycle boundary. A delayed Submit must not recreate historical position
      state after confirmed absence. Cover the check/admission/deletion race.
- [x] O15H-01: use the existing exact binding key for ordinary Tool/cancel lookup,
      retaining owner/tenant/closure checks and explicit enumeration where needed.
- [x] D15H-01: preserve the current native parallel-read intent grouping as a Pi
      upgrade contract test. No runtime batch restriction or position field is
      added. Revisit the protocol only if a real producer path needs multiple
      Cube effects in one record; ordinary concurrent tools do not imply that.

## Projector message and decoding review

The [October 15 focused review](reports/projector-envelope-review-20261015.md)
audits baseline `c3aca045`. Its 89 existing contract tests pass; isolated probes
reproduce retained child prefixes after writer closure, duplicated Tool display
bodies and repeated intent lookups. That review did not change runtime protocols;
the approved implementation follows below.

The owner subsequently approved implementation under
[ADR-0249](adr/0249-compact-projector-publication.md). The
[repair record](reports/projector-repair-20261015.md) records verified source and
the matched `projector-compact-bf55d9bd` deployment, real acceptance and cleanup;
the review evidence above remains tied to its baseline.

- [x] R15P-01: replace the internal full-text prefix with the minimum sequence
      state and clear every child view on forced writer closure. Preserve missing
      prefix detection, handoff positions, conflict checks and the public live view.
- [x] O15P-02: reuse validated per-record dispatch preparation and bounded native
      write lookup; remove repeated expansion without changing batch order,
      identity checks, projection transactions or commit-before-effect.
- [x] O15P-03 / C15P-01: deliver a matched compact envelope: inherit shared writer
      identity, derive aliases, share the original Boot reply target, and remove
      the unused standalone cancellation publisher. Separate wire facts from
      expanded commands; preserve self-contained control-tool recovery metadata.
- [x] O15P-01: extend same-commit presentation references to duplicated Tool
      input/result display bodies, keeping native interpretation in Worker and
      final results after Pi processing. Do not recreate a second result store.
- [x] O15P-04: separate fixed Cube request fields from workflow context checks
      and remove unused fixed-Tool context hashes. ADR-0249, matched guest protocol 5
      and fencing/cancellation/output-budget acceptance are complete.

## Reliability and capacity

The [October 14 complete Control Plane outage check](reports/control-plane-outage-20261014.md)
passes same-Run/Worker/lease/VM continuation, Kafka buffering and idempotent new
intake after 65 seconds at zero replicas. This is same-version recovery evidence,
not a new deployment operator or a guarantee for every active transport.

- [x] Implement [ADR-0248](adr/0248-idle-worker-management-reconnect.md) A1–A4:
      idle connection expiry/re-registration, atomic Boot/claim admission,
      failure tests and matched deployment/live acceptance. It is deployed as
      `worker-reconnect-5b6ba003` / schema 189; repository checks, 60/90-second
      outages and actual SIGKILL pass. [Delivery evidence](reports/idle-worker-reconnect-20261014.md)
      records full native-input, Cube, browser and final-patch outage acceptance,
      the input receipt read repair, preserved configuration and physical cleanup.
- [ ] Verify the dispatch-commit/Cube-handoff window and interactive workflow,
      terminal and preview connections before claiming fully transparent Control Plane updates.
- [x] Repair and verify owner-address cache invalidation under SP-03 above. The
      surviving-forwarder case is now reproduced; the zero-replica check restarts
      all such caches and does not cover it.
- [ ] After the handoff gates, provide a maintained compatible Control Plane-only
      image-replacement procedure with readiness, graceful exit, measured recovery
      and recorded rollback. The full matched-release operator still drains work;
      do not apply the lighter procedure to schema/Worker/Pi/Cube contract changes.
- [ ] Evaluate renewal of the existing 24-hour Boot registration credential before
      claiming long-lived Workers can reconnect indefinitely across Control Plane updates.
      Expired/revoked credentials still fail closed; management reconnect does not renew them.
- [x] Align the security-update download path with the existing Debian mirror
      policy after a proxied Debian download returned 502. The final release keeps
      exact security package versions and passes all artifact scans.
- [ ] Have the full Cube production driver invoke the existing owned-tenant purger
      after physical cleanup; it currently leaves its temporary account metadata.
      This delivery explicitly purged its three exact fixture identities, with
      the original account/configuration counts and digests restored.

The [October 13 consolidated plan](adr/0247-session-work-and-tool-dispatch.md)
is deployed as `session-work-6ac697f9`, schema 188 / execution-topic v16 / boot
reply v3. The [implementation evidence](reports/session-work-implementation-20261013.md)
records source, transport, recovery and rolling-replacement gates.

- [x] R13S-01 / P0: prove the public Pi APIs can manage native child creation,
      input identity, wait/blocked, supervisor exchanges, cancellation and recovery
      without a cloud child Run; freeze identity and completion mappings first.
- [x] R13T-01 / P1: co-commit ordinary cloud Tool dispatch with native intent;
      move trusted Tool business logic to handlers and unify final Kafka replies.
      Preserve Cube execution, dynamic workflow calls, mixed-record offset safety,
      long waits, typed failures, cancellation and native final settlement.
- [x] R13S-02 / P2: keep only root cloud work in Run admission. Migrate child
      models, resources, input/Stop, display/history, attachments and cleanup to
      root Run plus native identity. Remove child claims and duplicated command
      bodies/state only after every existing subagent action has a working replacement.
- [x] R13K-02 / P3: separate native child outcomes and ordered root-work completion
      from Session writer closure. Remove per-child seals/unsealed-count dependencies
      without weakening input races, history/SSE coverage or old-owner recovery proof.
- [x] R13K-01 / P4: implement direct Session producers with fresh post-init PG
      admission, control ordering, bounded fencing recovery and same-load resource
      measurement. Six RF3/PG primitive probes and two current ingress tests are
      baseline evidence. The direct publisher is wired; RF3/PG takeover, delayed
      initialization and same-Run recovery tests pass. Repository, real-model recovery
      and rolling-replacement gates pass.
- [x] R13U-01 / P5: complete the matched destructive cutover, retained-configuration
      checks and Luna/Cube/browser acceptance. Then prove compatible Control Plane
      handoff during active root work with Worker/Pi/Cube and protocol contracts fixed,
      instead of waiting for an entire Agent family to finish.

- [ ] Attribute and reduce Control Plane handoff latency before setting a user-visible
      availability target. The final image/stream case observed a 13.833-second Pod
      replacement and a 35.368-second maximum text-update gap; model generation,
      SSE reconnect and projection recovery need separate timings. Also measure
      native Session producer threads/FDs at larger concurrency before capacity claims.

[ADR-0243](adr/0243-native-input-current-state.md) is deployed with schema 185 as
`native-input-current-e82d00b7`. [Source and live acceptance](reports/native-input-current-state-20261012.md)
cover current Inbox/Submission values, checked reconstruction, actual Worker SIGKILL,
Stop/return, images and full Luna/Cube use. Configuration is preserved and fixtures
are physically cleaned. [ADR-0244](adr/0244-kafka-backed-native-live-state.md)
is deployed as `native-live-1370d871` under schema 186. Streaming live retention,
actual dual-process recovery and live acceptance are tracked in its
[report](reports/native-live-state-20261012.md).

The [native-log research/review](reports/append-only-storage-review-20261011.md)
compares pinned Pi, Maka, Marten, Pekko and Temporal. It retains the current four
storage tables and Session-local sequence; no runtime change was deployed.

- [x] R11L-01: validate retained journal counts/checksums and latest required
      current state during reconstruction, under ADR-0243. Missing/changed bodies
      fail with transactional index rollback; quiescent reconstruction and real
      asset restore preserve current values.
- [ ] O11L-01: reuse already-scanned document metadata in the bounded cold-read
      cache. One measured 512 KiB document read uses three SELECTs; the isolated
      reuse prototype uses two with identical content. Preserve cache invalidation.
- [ ] D11L-01: discuss retention of superseded native Task checkpoints and
      current-only document history beyond ADR-0243 input state. Streaming pi.live
      Kafka-only retention is deployed under
      [ADR-0244](adr/0244-kafka-backed-native-live-state.md). It retains small commit
      headers and verifies current reads,
      handoff, multi-Conversation replay references and attachment safety. Task
      reclamation remains separate work.
- [x] R12T-01: [ADR-0245](adr/0245-native-commit-text-presentation.md) uses
      same-commit assistant display descriptions without a copied text publication.
      Deployed as `native-text-c9b8b2a3`, schema 187 / topic v15. Source/fault checks,
      live input/Stop and dual-process recovery, browser/image, all multi-Conversation
      scenarios and full Cube acceptance have passing evidence. Interrupted
      upstream-TLS attempts and focused reruns are distinguished in the
      [report](reports/native-text-presentation-20261012.md).

- [x] Localize the intermittent model TLS failure: the
      [October 12 investigation](reports/model-egress-tls-20261012.md) reproduces
      the same three-second EOF directly through v2rayN/sing-box, without PiCloud
      or model requests. The pinned AnyTLS acknowledgement deadline matches the
      timing; a separate node TCP-connect timeout is confirmed by proxy logs.
- [ ] Resolve the external AnyTLS-path instability using node-side evidence or an
      operator-selected alternate path. The acknowledgement-timeout mechanism
      remains an inference until correlated with the node/runtime. The unchanged
      full Cube suite passed at 05:23 UTC; that closes the acceptance gap without
      proving intermittent connectivity fixed. Preserve the failed samples and
      keep Pi as the single model retry owner.
      The [October 18 lease delivery](reports/session-lease-repair-20261018.md)
      retains another TLS EOF/HTTP 500 during cold image recall; an unchanged
      owned-fixture repeat and the remaining live suite pass. This does not close
      the external connectivity item or justify a second model retry mechanism.

The approved [publication-registration optimization](reports/publication-admission-20261011.md)
is deployed as `publication-admission-c39a78f8`: known stale/closed identities
are rejected before PG, while potentially successful registration retains PG
authorization and closure/replacement guards. Source, RF3/PG, real Luna input/Stop
and Control Plane SIGKILL acceptance pass; owned fixtures are physically cleaned
and original accounts/configuration are preserved.

The owner approved R10C-01–04 from the
[Worker-claim table review](reports/worker-claim-schema-review-20261010.md).
[ADR-0242](adr/0242-worker-claim-schema-cleanup.md) implements bounded index access,
Run history indexing, removal of unused physical-Session metadata and Worker
database naming. [Source verification and matched deployment](reports/worker-claim-repair-20261010.md)
are complete as `worker-claim-5c803cc5`, schema 184. Real Luna/native-input/browser
and Worker failover/crash recovery pass; owned fixtures are cleaned and original
configuration fingerprints are preserved. Existing Run/lease/closure authorities remain.

[ADR-0241](adr/0241-missing-working-directory-tool-errors.md) is deployed as
`working-directory-889279b2`. [Source, fault and live acceptance](reports/working-directory-20261010.md)
verify known directory errors, same-Run continuation, explicit restoration and
preserved VM identity. The matched images include required Go/x-net security
updates; owned resources are cleaned and original configuration is preserved.

- [ ] Reassess long model output if the large-Read fixture recurs after its
      exact-short-label prompt. October 12 evidence located the delay in active
      model text streaming after Read (HTTP 200, 3.4 MB over 234 seconds), not an
      idle transport. The bounded repeat passed; no provider timeout or Tool-byte
      assertion was weakened. [Evidence](reports/native-input-current-state-20261012.md).

The [input-admission release](reports/input-admission-20261010.md) is deployed as
`input-admission-db0548b8` on schema 183. Initial intake uses eight business SQL
statements, and same-key retry uses two. Source/fault and real HTTP/Luna/Cube/browser
checks pass; original configuration is preserved and owned fixtures are removed.

The preceding [projection and commentary release](reports/projection-release-20261009.md)
deployed `projection-b14c3777` on schema 183. ADR-0239's SQL optimization
and shared text animation pass source and real Luna/Cube/browser acceptance;
owned fixtures are cleaned and original accounts/configuration remain intact.

[ADR-0238](adr/0238-native-input-queue-and-run-record.md) is implemented and
verified in source: two core Session/Run records, native follow-up/steer/editing,
confirmed native intake and removal of holding Runs/reconciliation. R08T-01–05
are complete in that slice, including unused columns, Worker naming and
first-position-only native projection writes. See the
[implementation evidence](reports/native-input-run-consolidation-20261009.md).

The [schema 183 matched release](reports/native-input-release-20261009.md) is
deployed as `native-input-a71a4807`; native queue, real Luna/Cube/browser and
configuration-preservation checks pass. Owned fixtures are physically cleaned.

The [architecture evidence review](reports/architecture-evidence-review-20261007.md)
prioritizes one bounded handoff/operability slice over another broad runtime
rewrite. The owner approved this slice; current source implementation includes:

- [x] D07-01: make the existing matched upgrade and its targeted live acceptance
      reproducible from maintained sources; remove caller-umask dependence from
      source verification and make fixture configuration restoration explicit.
      Preserve artifact checks, scoped cleanup and the serving release on preflight failure.
- [x] D07-02: mark superseded Run/Stop/Storage clauses in ADR-0161/0209/0219 and
      reconcile them with ADR-0229/ARCHITECTURE, without changing runtime behavior.
- [x] D07-03: define [bounded pilot criteria](PRIVATE_PILOT.md), intervention
      accounting and stop conditions. Actual pilot results remain unmeasured.
- [x] D07-04: add the optional [cold asset procedure](ASSET_RECOVERY.md) and real
      PG/two-store restore drill under ADR-0237. New Workspaces and fresh grants
      replace old execution/resource authority; exact native history and images survive.

The [matched release procedure](MATCHED_RELEASE.md) is maintained in source.
The [matched rollout](reports/readiness-release-20261007.md) now exercises this
workflow on the existing cluster. Operator driver fixes cover queued-image
visibility and cleanup after Stop; the final live acceptance passes. No new
runtime authority or protocol was introduced.
[Implementation and verification](reports/private-readiness-repair-20261007.md).

The same review proposes a small private-use pilot with agreed outcome/intervention
criteria before expanding infrastructure. Existing fresh-machine, fleet-load and
whole-deployment recovery items below remain separate claims. The owner explicitly
deferred backups of current disposable data; no backup or pilot was started.
Off-machine retention remains necessary before relying on irreplaceable history.
R07R3-04 remains owner-deferred.

The [recovery and boundary review](reports/repository-review-20261007-r3.md)
is complete at `1e7e21eb`, covering all 22 workspaces. Its new characterizations
leave product behavior unchanged. The subsequently approved repairs follow
[ADR-0236](adr/0236-recovery-input-identity-and-tool-diagnostics.md) and the
[source verification record](reports/review-repair-20261007-r3.md):

- [x] R07R3-01: distinguish cancelled, unstarted queue inputs from later actual
      executions when recovering a failed Session. Preserve exact exit/seal and
      stale-owner guards; verify both proof orderings with Stop queue return.
- [x] R07R3-02: end the matching uncertain submission identity when stopped input
      returns to the composer, so resending admits new work. Preserve newer
      post-Stop intents, unchanged retries, late ACKs and attachments.
- [x] R07R3-03: align oversized-line Read content and continuation diagnostics
      with pinned Pi 1.0 while preserving bounded source reads and image support.
- [ ] R07R3-04: remove CubeMaster's full configuration dumps and verify that
      startup/validation/reload logs exclude synthetic credential canaries.
      Explicitly deferred by the owner on 2026-10-07 for private deployment.
- [x] O07R3-01: avoid cold document-revision SQL when the acknowledged overlay
      contains the complete requested base/suffix. Retain native historical,
      version, checkpoint and eviction semantics and measure materialization cost.
- [x] Remove the unused Pi 0.84 model-stream classifier and simplify overlapping
      README release narratives while preserving versioned design evidence.
- [x] Deploy matched Tool Worker protocol 4 artifacts and the updated returned-input
      API/browser after draining old writers. No old-protocol compatibility mode.
      [Matched rollout and cleanup](reports/review-release-20261007-r3.md) preserve
      29 accounts/tenants and 30 model profiles; all owned live acceptance passes.

The [October 7 post-release review](reports/repository-review-20261007-r2.md)
is complete at `59541389`. Its four confirmed findings are implemented and
source-verified in the [repair record](reports/review-repair-20261007-r2.md),
following the [approved plan](reports/review-repair-plan-20261007-r2.md).

- [x] R07R2-04: scope composer submission identity across ordinary send and Steer;
      an intervening successful submission must not cause a fresh identical draft
      to replay an older request. Preserve unchanged retry and late-ACK behavior.
- [x] R07R2-02: remove multi-partition progress-lock coupling without weakening
      monotonic dispatch commits, group fencing or commit-before-effect.
- [x] R07R2-01: reclaim abandoned upload staging after process loss, preserving
      concurrent transfers, atomic finalization and shared Volume admission.
- [x] R07R2-03: apply EXIF orientation before image resizing/encoding for both
      user-image preparation and Tool reads.
- [x] Deploy matching application/Gateway and guest-protocol-4 artifacts after
      draining old uploads. [Release evidence](reports/review-release-20261007-r2.md)
      records destructive development cleanup, preserved configuration, matched
      protocol 7 / Tool Worker 3 artifacts and live acceptance (ADR-0235).
- [x] Rerun the additional whole-production multi-Run/cold-VM gate. The
      [new review's live evidence](reports/repository-review-live-20261007-r3.json)
      passes 21 Luna requests, preview/background reuse and fresh-VM Volume
      restoration without product changes. The prior model-proxy HTTP 500 cause
      remains unconfirmed; its historical failed runs are not relabeled as passing.

The same review distinguishes measured same-partition handoff blocking from the
cross-partition lock defect. Native template restore passed in two owned cases;
the earlier host-restart `SetGuestDateTime` failure remains unreproduced and needs
correlated cold-recovery evidence before changing timeout/retry policy.

The [October 7 whole-repository review](reports/repository-review-20261007.md)
is complete at `7a5fc603`. The [approved repairs](reports/review-repair-20261007.md)
implement its findings; the [schema 182 rollout](reports/review-release-20261007.md)
and owned live acceptance are complete:

- [x] R07-01: retain ordinary-send request identity across a lost response;
      unchanged retries must admit one Run, including attachment/first-message cases.
- [x] Q07-01: reconcile guest content-identity reuse with release provenance;
      retain the original image source revision and verify matching build inputs/digest.
- [x] O07-02: page Session headers before counting visible Turn history; preserve
      cursor/visibility semantics and verify plans with substantial isolated history.
- [x] O07-01: implement ADR-0234 shared access and narrow credential exclusion,
      preserving initialization/deletion/process-loss guarantees.
- [x] N07-01: correct the Projector's obsolete original-Tool-result waiting comment.
- [x] Deploy the October 7 source repairs with migration 182 and a drained
      Gateway Recreate upgrade; run owned live acceptance after rollout.

Partition head-of-line blocking, the Cube patch maintenance boundary and internal
lifecycle/UI cohesion are documented discussion items. Measure or define their
contracts before treating structural changes as authorized repairs.

The [October 6 post-Durable review](reports/repository-review-20261006.md) is
implemented and source-verified. [Repair evidence](reports/review-repair-20261006.md)
records the native request/event fixes, filesystem exclusion, bounded navigation,
SQL/dependency reductions and restored delivery checks. The
[matched production release](reports/review-release-20261006.md) is deployed.
It also updates stale Debian pins and the affected OS/Go dependencies, and aligns
image evidence with the actual versioned build and guest identity. Eleven release
images pass the documented fixable HIGH/CRITICAL gate; raw unfixed findings remain
visible in the evidence.

- [x] R06-01: restore Compaction summarize/retry identity under the new PG grant.
- [x] R06-02: correlate overflow/retry events and query executing Tools beyond
      display coverage without exposing uncovered assistant text.
- [x] R06-03: adopt filesystem-held exclusion under ADR-0231, including process
      loss, PG disconnect, replaced-inode and actual credential/GC tests.
- [x] R06-04: select navigation bodies through the native index; stream complete
      Fork prefixes in bounded batches under ADR-0232.
- [x] R06-05: reconcile current cancellation/queue/partial guidance and date the
      superseded evaluation/queue behavior.
- [x] O06-01/02: batch native metadata/revisions and use fixed indexed selector
      keys; single-delta SQL drops from ten to eight in the measured fixture.
- [x] O06-03: remove the CLI dependency from guest truncation; keep a licensed
      pinned helper subset with 1,100 upstream-output cases and bundle closure tests.
- [x] Q06-01: migrate and pass the native Subagent RF3 fixture, validate Tool
      identity before publication, and include the isolated transport gate in CI.
- [x] Q06-02: pin patched source-map-js and pass the audit without exceptions.
- [x] Deploy the matched schema 181 / Control Plane / Worker / Volume Gateway /
      guest release after drain and backup. Luna Tool, native Fork/prune, five
      Subagent scenarios, browser uploads and cold-Worker image recovery pass.
      The two historical UNKNOWN records retain their original identities.

- [x] Deploy [ADR-0230](adr/0230-complete-tool-call-publication.md): incomplete
      Tool calls stay outside Kafka/PG at the public Models port. Streaming text,
      payload-free activity and native complete-intent execution are preserved.
      Abort/truncation/reopen contracts, 190 fault cases and real Luna write/Bash
      acceptance pass; its initial Worker image was `complete-tools-af011ea46133`,
      superseded by the matched release above.
- [x] Verify Pi Durable 1.0 commit, recovery and remote Tool contracts under
      [ADR-0228](adr/0228-pi-durable-evaluation.md). The
      [executable evaluation](reports/pi-durable-evaluation-20261005.md) proves
      transport seams and records cancellation/recovery/queue mismatches.
- [x] Deploy the owner-approved [Pi Durable adoption](adr/0229-native-durable-runtime.md):
      native Harness/Storage, numeric Conversations, authorized same-Run recovery,
      ordered abort/Tool cancellation and queue return. [Release evidence](reports/pi-durable-migration-20261006.md)
      includes 186 fault cases, real Luna/Cube/browser/image/Steer recovery and
      matched schema 180 / execution-topic v14 artifacts. Automatic background
      Compaction remains outside the current cloud admission lifetime.

The [October 5 follow-up review](reports/repository-review-20261005.md) is complete
at `5c2fcab4`. Its original characterization tests are archived at `13344042`.
The [approved improvements and release evidence](reports/review-improvements-20261005.md)
record the matched implementation under ADR-0227.

The [proposed improvement slices](reports/review-improvement-plan-20261005.md)
specify executable POSIX recovery, bounded owner transactions/renewal, and shared
Tool outcome classification. Read concurrency was widened from two to eight as
requested; streaming image transport remains a separate future change.

- [x] R05-01: make failed Attach recovery executable through the actual POSIX
      Volume plugin, retaining pending-cleanup and shared-holder protection.
- [x] R05-02: bound lifecycle resource-lock waits so one resource cannot prevent
      controller-owner renewal; retain PG-time fencing and retirement serialization.
- [x] R05-03: preserve confirmed `not_started` replies during Agent Stop instead
      of relabeling them as an unconfirmed UNKNOWN outcome.
- [x] R05-04: apply infrastructure-failure classification and sampling refusal
      consistently to Workflow and fixed Tool paths, preserving business Tool errors.
- [x] R05-05: correct old Volume delta/co-commit comments and the migration's
      misleading `additive` description; document matched metadata/binary rollback.
- [x] Batch cold native-writer sweeps, collect Volume locks and wait for the
      desired Cubelet image before release checks. Preserve reference checks and
      the existing read/ownership authorities.
- [ ] Measure mixed fleet load before replacing the widened Read gate with
      actual-image streaming/backpressure; source sizing and transfer buffering
      remain distinct concerns.

The [October 4 whole-repository review](reports/repository-review-20261004.md)
is complete at `8d8ee837`. R04-01–07 and Q04-01 are implemented and deployed
under ADR-0224/0225/0226. [Repair and release evidence](reports/review-repair-20261005.md)
covers paused release, staged adoption, PG authorization/time, Fast Compaction,
structured Tool failures, Volume reference recovery and the restored browser gate.

[ADR-0223](adr/0223-recoverable-vm-allocation.md) is deployed: creation identity
precedes the physical effect, lost replies recover the original allocation,
closure excludes delayed creation, and unconfirmed node outcomes remain held.
[Verification](reports/vm-allocation-20261004.md) includes 178 fault cases, real
creation/closure races, Luna with Control Plane SIGKILL, and dedicated-machine
takeover, pause/resume and Volume release. Historical untracked allocations and
physical-node recovery limits remain in the operational items below.

[ADR-0222](adr/0222-paused-inputs-after-stop.md) was deployed before ADR-0229: Stop paused
pending human inputs; new input runs independently and explicit Send/Continue
queue resumes old input. [Verification](reports/paused-inputs-20261004.md) includes
172 fault cases and real Luna/browser/Worker-replacement acceptance.

[ADR-0221](adr/0221-pi-tool-cancellation.md) is implemented and deployed: ordered
operation cancellation, original native Tool settlement, bounded UNKNOWN and
durable abnormal retirement. It supersedes ADR-0220's detach-only semantics.
[Verification](reports/pi-tool-cancellation-20261004.md) includes PG/RF3 Kafka,
166 fault cases and real Luna/shared-VM normal and unavailable-API cancellation.

The [follow-up review at `3dbf49fb`](reports/repository-review-20261003-r2.md)
repairs are implemented under [ADR-0218](adr/0218-review-boundary-repairs.md) and
[ADR-0219](adr/0219-ordered-cube-admission.md): composed input budgets, PG clocks,
fair cleanup, explicit PG tests, isolated Kafka fixtures, scoped Subagent reads,
Run-directory verification, terminal dimensions and ordered Cube closure.
[Verification and release evidence](reports/review-repair-20261004.md) tracks completion.

The [October 3 review](reports/repository-review-20261003.md) repairs are deployed
under [ADR-0216](adr/0216-review-data-path-bounds.md) and
[ADR-0217](adr/0217-declarative-cube-release.md).
[Verification and rollout status](reports/review-repair-20261003.md) records the
upload/cancellation/reminder fixes, paged asynchronous queue views, scoped Lane
reads, streamed image normalization and one rendered Cube release.
Cancellation scanning now excludes pending admissions and already-cancelling
local Runs; ordinary active Runs retain the one-second missed-notification fallback.

- [ ] Measure cross-Worker Run-queue notification fan-out and ordinary active-Worker
      negative cancellation reads at fleet scale before changing the recovery cadence.
- [ ] Measure mixed API/image/queue load after the bounded read/stream changes before
      deciding whether the shared Control Plane needs process separation.
- [ ] Evaluate upstreaming/narrowing the pinned Cube native execution extensions;
      declarative release management does not eliminate their maintenance responsibility.

[ADR-0215](adr/0215-unlimited-product-quotas.md) is deployed: default resource and
product quotas were removed, uploads stream with verified identity, and matched
Cube/Worker contracts passed [unit, fault and live acceptance](reports/unlimited-quotas-20261003.md).

The [K3s cutover](reports/k3s-migration-20261003.md) is complete: old business
state was reset as requested; real Tool/image execution survived PG/Kafka/S3
Pod replacement and a Control Plane crash. Deferred Cube template-cache cleanup
and physical-node HA remain outside that acceptance.

The October 2 R02-01–04 repairs and accepted O02-01–05 slices are deployed under
[ADR-0213](adr/0213-control-recovery-and-propagation-budgets.md).
[Final source, budget, fault and production evidence](reports/control-recovery-repair-20261003.md)
records 1,650 assertions, 133 fault cases, real Luna/VM/browser tests and preserved
original history. Preview tunnel reuse and shared-resource invalidation remain
separate design questions, not an implicit part of the completed query merge.

- [x] Implement and validate [ADR-0212](adr/0212-ordered-control-read-models.md)
      in complete slices: binding publication/revocation, queued-input views,
      then Subagent directory and pending-work reconciliation. Preserve PG
      authority, owner takeover and shared-VM stopping boundaries.
      [Deployed acceptance](reports/ordered-control-views-20261002.md) records
      measured read counts, real-model/browser/failure checks and preserved assets.

- [ ] Measure ADR-0211 probe scheduling lag and false-unconfirmed rate on actual
      multi-node fleets before raising concurrency or claiming fleet-wide detection
      deadlines. [Current acceptance](reports/execution-probes-20261002.md) proves
      160-target scheduling and single-host real execution, not physical fleet scale.
- [ ] Separate provider first-token latency from phase-aware first-display latency
      in future timing comparisons. Native partial-commit coalescing, transport
      and browser animation contribute separate delays; they must not all be
      labelled as internal relay time.
      The [October 25 first-response investigation](reports/model-first-response-investigation-20261025.md)
      confirms four consecutive local header timeouts and CLIProxyAPI's initial
      data-frame gating. The [240/270-second header-wait policy](reports/model-header-budget-delivery-20261025.md)
      is deployed with unchanged binaries and real Luna acceptance. Add payload-free
      upstream phase timings and preserve specific native failure presentation as
      a separate repair slice. The underlying upstream delay is not established;
      successful ordinary acceptance does not prove the old slow requests recover.

- [ ] Audit historical untracked Cube Volume references independently. ADR-0226
      repairs managed cleanup-reply loss using durable node state; it cannot
      fabricate missing historical node/store identity. The
      [older observed drift](reports/run-identity-acceptance-20260919.md) is not
      blanket evidence that every legacy count is safe to clear. Preserve guards
      until the recorded physical state is independently verified.

- [ ] Discuss drain/completion durability before any further boundary merging.
      [Terminal wake and transaction-local SQL](reports/terminal-wake-acceptance-20260918.md)
      are implemented; shared-row/WAL tails remain. The [ready-admission acceptance](reports/ready-admission-20260919.md)
      still saw a 353ms terminal tail, concentrated between settlement and seal
      publication; its exact wait was not sampled. Do not remove the drained
      output proof or weaken seals merely to reduce commit count.

- [ ] Attribute remaining cold-start and Node callback/CPU tails after
      [two-way admission](reports/parallel-claims-20260918.md). Four-concurrent
      startup median improved 213→194ms in the bounded comparison, but cold
      requests can still exceed 400ms. Some query spans include client-side
      delay after PG is already idle; do not label all elapsed time as WAL I/O.

- [ ] Isolate the remaining host-storage tail below the confirmed PG `WalSync`
      wait. The [approved NVMe A/B/A trial](reports/nvme-power-trial-20260918.md)
      did not eliminate >100ms tails, and original host settings were restored.
      [Native-host comparison](reports/native-storage-tail-20260918.md) also
      reproduces the tail on the SSD hosting WSL, while a second SSD did not in
      these samples. Distinguish competing I/O, device/driver and power behavior;
      no specific fault is established. The [Lenovo standard-mode A/B/A trial](reports/legion-performance-trial-20260918.md)
      reduced typical real-GPT startup from 119ms to 63ms, returning to 117ms
      after restoration, but >100ms storage tails survived. Original mode/plan
      are restored; no laptop-specific deployment default is justified. Durability stays on.
- [ ] Keep the [unexplained historical SSE opening](reports/stream-reopen-investigation-20260909.md)
      distinct from intentional stale-snapshot replacement. The final 200 browser
      checks have no unexpected openings; that does not identify the old root cause.
- [ ] Validate executor/node loss beyond ADR-0210's implemented boot-scoped
      admission and cgroup stopping. The earlier
      [generation study](reports/cube-execution-generation-study.md) remains historical
      evidence, not a statement that scoped fencing is absent today. Durable
      cross-boot process/result recovery and ordinary shell effects remain UNKNOWN.
- [ ] Validate PostgreSQL/PgBouncer failover, Cube compute-node drain and shared
      Volume attachment on actual independent machines.
- [ ] Measure producer latency across Session counts, canonical projection
      throughput/WAL and live-tail memory with 2,000/10,000 SSE connections.
- [ ] Validate KEDA and Kafka partition sizing against the intended enterprise
      workload, not only a single-host synthetic producer benchmark.
- [ ] Measure the shared Session writer/Projector across growing active and historical
      Lane counts; unlimited product defaults do not establish sustainable capacity.

## Deployment operations

- [ ] Wait for current Cube node registration/health before template creation
      after native replacement. In the October 15 matched release, Kubernetes
      readiness preceded Master discovery of the new Cubelet address; template
      creation failed while Master still polled the old Pod IP. A second apply
      of the same scanned artifacts passed after registration and complete
      zero-VM inventory. Add a bounded native-readiness gate and a replacement
      regression; retain fail-closed cutover and physical cleanup requirements.
      [Evidence](reports/projector-repair-20261015.md).

- [x] Reconcile the build host's Docker daemon proxy with its current proxy
      endpoint. October 10 uncached pulls needed a temporary loopback relay;
      it was removed after building and is not a runtime component. Host service
      configuration was not changed by that release.
      The October 18 [settlement release](reports/worker-harness-settlement-repair-20261018.md)
      again found the daemon using an inactive loopback endpoint. A temporary
      systemd socket proxy restored build access and was removed before rollout
      and live acceptance. The owner-authorized October 19 permanent fix points
      Docker HTTP/HTTPS at the active 10808 endpoint, preserves NO_PROXY, restarts
      the daemon and verifies an actual image pull. The temporary relay is removed;
      [delivery evidence](reports/seal-projection-repair-20261019.md) retains the
      initial restart caller timeout and subsequent verified service recovery.

- [ ] Investigate Cube standard/performance-template snapshot restoration returning
      `reset guest time failed` despite READY status. Recreating the same-image
      template restores boot and image-queue acceptance. The October 21 performance
      template repeated this failure; same-image regeneration restores its real
      boot and all 97 browser controls, and a bounded retry confirms deletion of
      the old template. The upstream failure
      mechanism is not established. Preserve creation uncertainty and node-absence
      requirements; no forced quota release or identity fabrication for failed
      allocations lacking a recorded VM/node. [Original evidence](reports/review-repair-20261004.md).
      The two legacy records/Volumes were removed during the owner's explicit
      [October 7 development cleanup](reports/review-release-20261007.md), after
      quiescence and confirmed managed Volume deletion; this does not establish
      the snapshot-restore failure's underlying cause.


- [x] Resolve the historical Cube node template-cleanup timeouts through current
      node discovery. [Acceptance](reports/template-cleanup-20261007.md) covers
      replica/artifact routing, retained failures, shared references and actual
      cleanup of the accumulated 55 candidates without weakening pinning.

- [ ] Investigate the 4GB Cube template restore failure seen after a WSL reboot:
      CubeShim's `SetGuestDateTime` RPC timed out twice before guest tools started.
      Rebuilding that specification from the same image restored creation, but
      the underlying snapshot/vsock failure is not yet established. No automatic
      template replacement, Tool retry or weaker readiness was introduced.
- [ ] Run the one-host installer on a genuinely clean machine; current K3s
      cutover tests do not establish that broader claim.
- [ ] Reconcile Cube Volume node references after host/guest loss; template cleanup
      via stable node identity is completed separately under ADR-0233.
- [ ] Decide a local Cube MySQL binlog retention policy. Earlier disk cleanup
      did not change its 30-day default. [Evidence](reports/environment-reset-20260910.md).
- [ ] Add deployment-specific Kafka TLS/SASL/ACL examples and wire real on-call
      notification destinations into Alertmanager.
- [ ] Validate deployment-owned coordinated PG/Kafka/Cube backup and restoration.
      The unsupported whole-system archive CLI is removed, not replaced by a
      claimed disaster-recovery product. ADR-0237's bounded conversation/image
      restore is verified separately; it excludes old Kafka work, VMs and Workspace
      files and does not establish physical-node HA or a full-deployment restore.
- [ ] Repeat GitLab project credentials, private clone, multi-user non-exclusive
      claims and elastic/machine Issue execution against an external TLS instance.
- [ ] Design GitHub user authorization before restoring App onboarding; current
      support is limited to already-bound integrations and environment Git credentials.

## Deliberately deferred capabilities

- [ ] If a second sandbox backend is selected, evaluate its public execution,
      cancellation/output-retention and lifecycle contracts against
      [the October 8 source study](reports/sandbox-result-portability-20261008.md).
      Record an ADR and run the same failure/isolation acceptance before enabling
      it. The study does not authorize a backend migration or new execution authority.

The [October 7 Flash acceptance](reports/deepseek-flash-acceptance-20261007.md)
passes ordinary text, file/Bash tools, high-thinking follow-up and image input.
It leaves the hosted-search investigation below unchanged and adds no runtime
or model-configuration change.

- [ ] Decide whether large text/structured Tool results need general attachments.
      Current Subagent results use ADR-0196's explicit bounded admission; image
      attachments do not imply unbounded ordinary result storage.

- [ ] Define project text-resource discovery separately from executable extensions
      if that feature is requested. Automatic AGENTS.md loading (review PI-06) was
      not an existing promise; the repair preserves pure chat without Cube and the
      code-owned Runner boundary. Trusted native hook composition does not itself
      implement durable user approval.

- [ ] Recheck DeepSeek's early assistant phase before enabling final-only streaming.
      The current route revises a Tool preamble from final_answer to commentary
      at completion; GPT's phase-aware presentation must not be copied blindly.
- [ ] Benchmark Standard/Fast on enabled GPT models before changing the default.
- [ ] Replace PiCloud's hosted-item adapter when pinned Pi has a backend-conformant
      native contract. Recheck Flash's Responses search when upstream support
      changes: Flash is selectable with the owner's requested `web_search`
      declaration, but September 26 probes still return no search on that route.
      Anthropic Messages search works; changing protocols or adding a substitute
      search tool remains a separate slice.
- [ ] Add generated-image results only with native storage,
      Compaction and cross-Worker/provider recovery contracts.

These are not authorizations for a new architecture or feature. Changes to
ownership, persistence, execution or recovery semantics require owner discussion.
