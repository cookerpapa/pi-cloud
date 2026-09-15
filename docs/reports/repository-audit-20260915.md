# Repository audit and system validation — 2026-09-15

Base: `1d7d7f8f`. Status: **in progress; not a full-review completion claim**.
Prior reports are historical evidence, not a substitute for this campaign.

## Scope and execution

Read maintained code, tests, migrations, deployment, configuration, CI and current
documentation. Identify generated/dependency material separately. Track file
hashes and reviewed line ranges in one private machine-readable ledger; reread
changed files. Do not infer whole-file coverage from search or truncated output.
No delegated review agents. Change current semantics only after owner discussion.

Sequence: verify implementation → README → complete static review and local
regressions → real product/API/UI and concurrent workloads → failures/latency
analysis → final clean-state retest → fixture cleanup → final report → resume.
Resume changes wait until completion and use v11; existing v9/ESG work is preserved.

Web-origin slice: `web:deployment:check` exercises the current built frontend
through the real Caddy image on allocated product/admin ports, with an owned
identity-only HTTP fixture. Both account-type redirects and configured-only
management links pass; the container, listener and Chrome profile are removed.
This is deployment/UI acceptance, not paid model acceptance. A separate isolated
Caddy probe also checks custom upstream DNS, Preview routing and JSON escaping
for configured link values. The existing Chrome presentation suite, installer,
Helm, documentation, 134 Web tests, Web types/build and formatting checks pass.
Production Web is deployed at `d923dbb9`; its configuration endpoint returns the
expected local origins. Other application images remain `9f62b365`. Runtime configuration is evaluated only
on the fixed code-owned endpoint, never on user Preview responses, following
[Caddy's template boundary guidance](https://caddyserver.com/docs/caddyfile/directives/templates).

## Coverage

Initial inventory: 922 tracked files. The large line count includes tests,
historical schema migrations, deployment and generated evidence. Dependency
lockfiles need dependency/CI validation rather than manual source review.

| Area | Code review | Runtime/combination acceptance |
| --- | --- | --- |
| Implementation map / README | Entry-point/data-flow map updated; detailed file coverage continues | Runtime inventory read-only |
| API, auth, resources, Run admission | Controller/auth/composition/store and machine service read; remaining resource/control services in progress | Paid product-surface, six real-PG admission/replay cases and cross-tenant rejection pass |
| Worker ownership, queue, capacity | Authority/claim paths reviewed and corrected; remaining Worker coverage tracked privately | Family renewal, Worker SIGKILL/replacement and 16 active Sessions tested; pre-provider latency remains open |
| Native log, Harness, Lanes, Compaction | Session backend package read; cancellation/projection-wait finding remains open | Real-PG plans; two native Compactions during 13 coding rounds; combined child/Compaction coverage still incomplete |
| Kafka, projection, streaming and recovery | Producer/startup policy and selected projection/seal paths reviewed; remaining code pending | R=3 throughput, CP/Kafka SIGKILL, visible-prefix recovery pass; final combined rerun pending |
| Tools, Cube, Volumes, machines, Preview/SSH | Broker/transport/Volume implementations read; remaining Cube lifecycle code pending | Paid coding, same-Workspace concurrency, actual Snake browser play and machine controls pass; remaining lifecycle faults pending |
| Model routing/configuration and hosted search | Adapter/relay and configuration paths reviewed; remaining code pending | GPT/DeepSeek, reasoning/Fast, Worker handoff and search around Compaction pass on recorded revisions |
| Subagent lifecycle and communication | Core lifecycle/mailbox/native bootstrap paths reviewed; remaining code pending | 11 paid production scenarios pass at 9f62b365, plus family fairness and Worker-loss recovery |
| Frontend pages, controls and rendered latency | Main components and browser interaction fixtures reviewed; remaining paths pending | 93 deployed controls and actual terminal pass; DOM timing is not yet a compositor-paint measurement |
| Configuration, deployment, migration, CI, monitoring | Partial coverage; current pending findings below | CI passed at 9f62b365; actual custom Web origins under test; separate K3s Authorizer rollout pending |
| Scripts/tests/current docs and unused-code cleanup | Partial hash/range coverage; not a full-read claim | Local check: 919 pass / two gated skips at 9f62b365; clean-state final matrix/cleanup/resume not complete |

## Required live matrix

Track separately: single/multi-round/reload; same-user multi-Session; multi-tenant;
Worker handoff; provider/model/reasoning/Fast handoff; repeated Compaction with
coding/search/children; direct/workflow, fresh/branch, shared/isolated Subagents;
multiple services in one Session and across Sessions; actual Preview behavior;
cancel/failure/restart and cleanup; every reachable core UI action.
Use gradual bounded load in this project's environment. Hosted search uses the
normal provider capability, never third-party load testing.

Latency must distinguish backend admission, queue/claim, context/model preparation,
provider first text, publication/projection, SSE receipt and actual browser paint.
Do not subtract unrelated sampling intervals or invalid cross-host wall clocks.

## Findings and decisions

| ID | Observation | Status / next proof |
| --- | --- | --- |
| CP-01 | `main` provides an HTTP Steer backend factory, but runtime composition dropped it; the service used the local WebSocket path instead | Fixed by forwarding application options intact; API regression returned 503 before and 200 after, with no local Worker socket. Live multi-replica retest pending |
| CP-02 | Admission metrics were dropped by runtime and module composition before reaching the store factory | Fixed wiring; API acceptance and resource-create histograms now observe samples. Same regression failed before, passes after |
| AUTH-01 | Both authenticators awaited a usage UPDATE on every valid request, even within the five-minute refresh interval | Reproduced redundant SQL calls; use `last_used_at` from the authority read to skip fresh updates, preserving conditional concurrent refresh and uncached revocation checks. 12 auth/gateway tests and type check pass |
| LIFE-01 | Worker creates/listens on Model Gateway, but records it for cleanup only after upstream health succeeds | Reproduced a live listener after failed startup. Register ownership before startup awaits (also the owned Kafka log); two Worker runtime tests and type check pass. Kafka partial-start failure still needs separate injection |
| LIFE-02 | Control Plane orderly shutdown stopped cleanup after the first rejected close | Reproduced skipped Projector/DB/metrics closes. Share one ordered teardown on startup failure and shutdown; attempt every close and surface aggregated errors. Two lifecycle regressions pass |
| MEM-01 | Control Plane cached management wrappers for every historical Worker URL | Removed unused object cache: wrappers hold no connections and already share the HTTP dispatcher; no routing/authority change |
| RESTORE-01 | Investigated whether open fetches already-reconciled interruption prefixes | Ruled out: native projection clears the prefix and migration 131 provides a pending-only partial index; no extra cache or query rewrite added |
| UI-01 | Product/admin origin detection and redirects hard-code ports 8080/8081; management links guess ports of optional services | Web now loads a non-secret deployment configuration once per document; explicit origins replace port inference and absent component links are hidden. Helm exposes the admin Service/Ingress route. 134 Web tests, types/build, custom Helm render, actual Caddy + Chrome bidirectional redirects on allocated ports and deployed 93-control repetition pass |
| DEPLOY-02 | Helm deploys a release-prefixed Control Plane service but Caddy hard-coded Compose DNS | Helm regression reproduced missing upstream configuration. Pass chart-derived API/Preview upstreams and parameterize Caddy's API route. Isolated Caddy/HTTP fixture validates both routes under a different service name; admin-origin/port behavior remains UI-01 |
| UI-02 | Logout silently treated network failure as success and retained machine/dialog state in the mounted app | Browser reproduced false logout. Surface failure; successful/expired logout replaces the document so old account callbacks/caches cannot reach the next login |
| UI-03 | Composer and initial-prompt creation both sent `thinkingLevel: off`, overriding persisted Session settings | Real React/Chrome request-builder regression captured `off` in all three submissions despite medium/high selection. Remove obsolete overrides; GPT Fast/high → DeepSeek also tested without model execution |
| UI-04 | A terminal SSE arriving before the HTTP acceptance reply was reset to queued by `turn.accepted` | Reproduced; preserve terminal status while filling accepted prompt/Run metadata. Covers completed, failed and cancelled |
| UI-05 | Tree refreshes can finish after selecting another Session; new-chat/resource actions are not all guarded during pending mutations | Chrome reproduced a late prune-triggered focus refresh replacing the selected full tree. One generation/scope guard now covers automatic and explicit tree reads; stale responses/errors/loading changes are ignored. 130 Web tests and the browser fixture pass. Pending-mutation navigation still needs its own check |
| UI-06 | IME Enter submitted text; accepted sends/Steers cleared newer drafts | Browser reproduced IME submission and lost pending draft. Ignore composing Enter, clear only the submitted draft revision, preserve an already-focused caret |
| UI-07 | Late file A response appeared below selected file B; directory refresh retained stale loading flags | Browser reproduced wrong selected content. Per-file request identity plus directory generation; clear obsolete loading state |
| UI-08 | Run completion refresh unmounted the human terminal; Inspector inferred machine identity by fetching its entire catalog | Browser reproduced unmount. Separate file refresh from terminal lifetime; pass exact Session binding/directory, refresh files on Workspace change, remove redundant catalog lookup |
| UI-09 | Old terminal WebSocket callbacks changed the replacement connection's state | Browser with controlled socket lifecycle reproduced late-close disconnect. Ignore retired socket callbacks and close prior transport before reconnect |
| UI-10 | Empty child labels did nothing; local tree jumps did not notify tail-following logic | Browser reproduced both. Labels select the branch independently of entries; explicit local-jump callback stops auto-follow |
| UI-11 | Failed directory reads left Choose enabled; navigation could race directory creation | Browser reproduced stale selection. Only a loaded directory is selectable; disable navigation during the owned create operation |
| UI-12 | Fenced `python`/`rust` and four other registered language names had no highlighting; edit deletion was treated as missing text | Six highlighting and one deletion regression failed before; recognize registered names and preserve empty replacement strings. Removed unreachable Tool-stream cursor and suffix plumbing |
| UI-13 | Clipboard fallback left a hidden textarea and lost focus on rejection; SSH bypassed the HTTP-capable copy helper | Browser reproduced retained textarea/lost focus. Always remove and restore focus; use the existing helper for SSH and surface failures |
| SC-01 | Issue start retained a home-subdirectory restriction despite full-VM directory selection | Reproduced rejection of `/home/user`. Share ordinary Session path validation; `/home/user`, `/srv/issue-project`, `/` pass and malformed paths still fail. Removed stale UI guidance |
| SC-02 | GitLab refresh replaced the internal clone address; GitHub credential context used the configured GitLab workspace origin | Both reproduced using local provider fixtures. Preserve internal clone routing on refresh and choose credential origin by the actual provider |
| SC-03 | Claim-note sync cleared its pending bit before the external effect | Real PG observed false while the external note write was unfinished. Keep the job row locked/pending through its existing bounded metadata upsert; clear only after success or a classified permanent failure. Another reconciler skips the locked job; lost replies retain pending and retry the existing marked note without duplication. Five source-control cases pass in real PG and PGlite; type check passes. This low-volume path holds one job lock during the provider call, not Session/Worker locks |
| SC-04 | Issue credential authorization omitted the machine owner check used by ordinary Code Host connections | Reproduced successful preflight as another user in the same tenant. Share the existing ownership check before credential requests |
| SC-05 | Single-Issue mutation responses searched only the newest 100 jobs; list query fetched unused large Issue bodies | Reproduced durable claim followed by not-found after 101 newer jobs. Filter detail by tenant/ID and select only public summary columns; no Issue bodies in list reads |
| SC-06 | Optional GitHub App callback validates PiCloud state but not caller access to the supplied installation | Owner approved removal (ADR-0169). Removed installation/callback routes, link schema, state-request table and slug configuration. Authenticated HTTP probes return 404; bound integration refresh/Webhooks and ordinary environment credentials retain coverage |
| UI-14 | Blank-line segmentation split lists, four-backtick fences and indented code; settlement replaced already-rendered paragraphs | Four rendering failures and a Chrome DOM-replacement failure reproduced. Use the same remark/GFM parser, retain the two unresolved suffix blocks, invalidate reference-dependent blocks, and keep nodes at settlement. Every-character prefix checks pass for six syntax cases |
| SC-07 | Non-object GitLab webhook JSON raised TypeError before the intended shape rejection | Three payload-shape regressions reproduced 500-class errors; reject through the existing invalid-webhook contract |
| SC-08 | Missing Workspace credential-service configuration fabricated a known placeholder token | Reproduced misleading Broker URL error; fail explicitly as unconfigured instead of sending a placeholder credential |
| SC-09 | Issue coordinator reused Sessions by title, could recreate missing Workspaces and forced thinking off | Reproduced unrelated same-title Session reuse and the off override. Create native Session + accepted Run + job link in one existing PG transaction; require the selected Workspace and inherit model settings. Injected failure after Session creation rolls back both product/native roots and leaves no Run |
| SC-10 | Retired Issue owner could mark the Webhook delivery failed after losing the job | Reproduced late failure overwriting delivery. Only project completion/failure when the owner-conditioned job update succeeds |
| CLEAN-04 | GitHub PR/comment and GitLab MR methods had no callers; one exposed credential getter was unused | Removed 188 lines of retired delivery/token code. Discovery mints metadata-only credentials; Issue intake no longer requires repository/PR write permissions |
| SC-11 | Code Host response limits were checked only after `arrayBuffer()` buffered the entire body | Both providers reproduced reading past the 4 MiB budget. Shared response reader cancels on overflow; preserves provider-specific status errors and classifies interrupted bodies as unavailable |
| UI-15 | Mobile chat lost its height constraint; admin content overflowed the hidden body; short directory dialogs clipped Choose | All three reproduced in Chrome at 400×550. Retain flex chat layout, bound admin height, and let directory content shrink/scroll while actions stay visible |
| UI-16 | Stable translation callback hid language changes from memoized admin links and Markdown placeholders | Both reproduced through the actual language menu. Remove trivial admin memo and subscribe Markdown bodies to language context; no request refetch or model changes |
| CLEAN-05 | Unused new-chat Workspace deletion / retired project-connection styles and misleading committed-file wording remained | Remove unreachable styles, describe live Volume reads/Lane views, and stop labeling every machine terminal `/workspace` |
| CI-01 | Helm check still required the Control Plane notification-DB mount removed under CFG-02 | Confirmed from remote CI run 34897307551. Assert its absence and CP pooled-key mapping; preserve the Worker's real notification connection check. Local Helm/docs checks pass |
| UI-17 | Markdown export spread every backtick run into `Math.max`, exhausting the engine argument limit | Reproduced with a 280K-character owned code fixture. Compute the longest fence iteratively; three export tests pass. Removed an obsolete cast that hid an invalid resource fixture |
| UI-18 | An interrupted sampling left Hosted Search running, then a successful Run terminal relabelled it completed; snapshot folding also retained abandoned Tool preparation | Failed/aborted sampling regressions reproduced this. Close those display activities at the sampling boundary in both live and snapshot reducers; 28 projection/UI tests pass. This does not fabricate a hosted search result in model context |
| MUT-01 | Rebind and cancel check idempotency before acquiring their lifecycle row locks, then reject concurrent replay | Both reproduced with real PostgreSQL barriers: rebind returned not-found after its joined row changed; cancel returned already-in-progress. Lock the Session/lifecycle before reading replay; rebind reads the current Workspace after the lock. Remove the cancellation constraint-retry wrapper. Six real-PG admission/replay cases pass; compiler rerun is tracked below |
| LIFE-03 | Active Lane cold-history waits use the shared writer signal, not the task's cancellation signal | Candidate blocked cancellation; trace Runtime abort and test projection lag without poisoning sibling Lanes |
| CANCEL-01 | `abort()` was lost before the native Agent existed; cancellation during intent ACK still called the Tool | Reproduced model/effect calls after cancellation. Latched cancellation, checked the existing signal after intent commit, and kept aborted native outcome; unit regressions pass |
| CANCEL-02 | A local pre-sampling abort was classified as an assistant completion missing a Cloud Step | Reproduced through Runner; recognize the explicit no-sampling cancellation without inventing a Step. Runner/Harness suite: 48 pass |
| CANCEL-03 | Acknowledged cancellation failure changed business state but omitted the output seal and task-authority release | Reproduced missing Outbox terminal and zero release calls. Reuse failure closure in the same transaction; seven queue tests pass. Keeps the existing failed/quarantined Session state, not a successful cancellation |
| LIFE-04 | A destroyed publisher blocked every later claim but left the Worker apparently healthy forever | Reproduced no terminal signal after permanent failure. The log port distinguishes unreusable publisher failure from transient metadata outage; Worker stops local execution and signals process replacement only for the former. Readiness follows actual admission readiness. Seven transport/runtime regressions pass, including transient recovery |
| CFG-01 | Producer startup checked partition count but not existing topic replication/retention policy | Six negative startup cases reproduced accepting unsafe settings. Validate assigned replica count and the same policy used at creation; no automatic reconfiguration or per-event check. Eleven unit cases and a real three-broker test with seven disposable topics pass; all temporary topics deleted. Do not confuse configured replicas with currently healthy ISR members |
| MUT-02 | Tenant admission locks the smallest existing tenant UUID, which can change when a new tenant is inserted | Three real-PG requests reproduced exceeding the configured limit. Use the same short tenant-table writer lock for registration; no Agent/Workspace lock added. Four administration cases pass; compiler rerun is tracked below |
| OBS-01 | Rejected metric collection escaped a native HTTP async callback | Reproduced a hanging scrape plus unhandled rejection. Return 503 for that scrape; next scrape succeeds |
| OBS-02 | Trace status used a safe error code but exception events still exported the raw message/stack | Reproduced with a synthetic secret in an owned error. Export only classification, rethrow the original error to its caller |
| CFG-02 | Control Plane parsed/mounted an unused dedicated PG notification URL | Deleted CP option/mount; Worker's actual LISTEN connection and bootstrap direct-PG settings remain |
| CFG-03 | CP/Broker/Volume Gateway rejected group-readable secrets while Helm mounts them 0440 under fsGroup | CP and Broker loaders reproduced failure with owned 0440 fixtures; aligned process-group read permissions while rejecting group writes/world access/symlinks. 44 Bootstrap/Broker/cleanup regressions pass. Actual Kubernetes startup and Volume Gateway child-process check remain pending |
| CFG-04 | Several private RPCs followed Node's global provider proxy, breaking Pod-IP/cluster routes | A real child process with an owned rejecting proxy reproduced Broker unavailability. Explicit direct dispatchers now cover Broker, Volume, Cube control, machine lifecycle and Worker enrollment; configured private GitLab routing is separate from public provider routing. A positive control confirms normal requests still use the proxy; 32 related regressions pass |
| DEV-01 | Machine creation checked replay before the tenant lock | Real PostgreSQL barrier reproduced one identical request failing `projects_tenant_live_name_unique`. Move replay into the existing tenant-locked admission; both return one running machine. Nine real-PG lifecycle cases pass |
| DEV-05 | Pause/resume replay treats a recorded request as a completed effect | Remaining candidate: distinguish a lost request/reply and a later opposing action without replaying obsolete lifecycle effects |
| DEV-02 | Machine lifecycle descriptor requires an active Domain and non-failed environment profile, including release | Reproduced both rejected releases via the actual Broker HTTP fixture. Separate owner-scoped existing-machine routing from new provisioning descriptor; directory operations and release no longer depend on allocation policy. Cross-user checks remain. Local regression slice passes; deployed Cube repetition pending |
| DEV-03 | Broker concurrent duplicate machine provisioning created two provider runtimes; simultaneous first task bindings chose the same binding ID | Both reproduced. Reuse existing per-Workspace provisioning critical section for machine provisioning/binding creation, not Tool execution. Concurrent parent/child bindings now stay distinct and reuse one runtime |
| DEV-04 | Machine handle entered the ready map before durable state publication; failure destroyed the VM but retained that handle | Reproduced phantom active count. Publish PG state before installing the ready handle; clean failure no longer advertises a destroyed runtime |
| TOOL-01 | A reused persistent-machine binding could return a cached response belonging to an earlier Attempt | Reproduced by delaying old-body retirement while rebinding. Match the reader Attempt as well as binding ID; no PG round trip added |
| CLEAN-01 | Binding-local `materializing` was never written; old terminal-capacity transfer path had no reachable caller | Removed the field/branches/transfer method and its dead-feature test. Physical runtime materialization and concurrent Tool execution remain |
| CLEAN-02 | Native Lane exposed its private reader despite having no caller; one Fork test name incorrectly implied no payload copy anywhere | Removed unused getter; clarified shared query projection versus self-contained Fork log. No persistence semantics changed |
| CLEAN-03 | UI still polled Run state as a second pre-stream completion fallback | Removed UI poll/action. Live Snake exposed that removing the API client's `getRun` also broke diagnostic/acceptance callers outside the Web package; restored that required read-only method and added an API contract test, without reintroducing UI polling. Full live matrix remains pending |
| TEST-01 | Chrome helper selected a random fixed port, risking another browser under concurrent tests; debugger disconnect could strand pending RPCs | Use Chrome's allocated port from its own private profile, reject pending calls on disconnect, and report cleanup failures. Browser presentation/composer regression passes; parallel browser stress still pending |
| LIFE-05 | Broker HTTP listener remained open after provider teardown failed | Reproduced with actual local listener; close HTTP in `finally`. Eight RPC/server regressions pass. Also removed unreachable HTTP-side Tool timing branch; executor owns execution timing |
| FILE-01 | Trusted Git preflight discovered a Workspace's `.git/config` | Owned fake-SSH marker reproduced local config execution. Run network preflight outside user directories and disable global Git config; no real credentials or external server involved |
| FILE-02 | Credential reads followed a Workspace symlink outside its volume | Reproduced against an owned fixture; open non-following, nonblocking regular file and bound actual bytes read |
| FILE-03 | Browser path validation could race a parent-directory replacement before open/readdir | Reproduced outside fixture content/names. Validate the opened Linux descriptor and retain it for listing; bound reads if files grow after stat. Volume regression suite passes |
| PERF-02 | Git preflight held the Volume lock/PG lock connection during remote network wait | Reproduced blocked directory access; release after reading the credential, then perform the independent network probe |
| LOCK-01 | Volume advisory-lock connection failure is detected after the filesystem callback completes | Confirmed with two real Gateway instances, isolated PG and temporary files: pause A after copy, terminate its PG backend, let B publish and write a marker, resume A. A reports failure but its recursive target removal changes B's acknowledged generation and deletes B's marker. Storage-contract change requested; no fix applied yet. Proposed atomic non-overwriting publication must coordinate with Cube Plugin's initially nonempty Workspace directory. No real Workspace was affected |
| MEM-02 | Supervisor retained completed Assignments and publisher contexts, plus command/control bookkeeping | Reproduced 64 completed synthetic Runs retaining all 64 publishers and ~65 MiB of owned buffers with zero active Sessions. Clear the publisher at completion/pre-start release: zero publishers and ~1 MiB remain; completed duplicate commands still reuse their outcome. Long-term command/control/epoch bookkeeping retention remains under review |
| LIFE-06 | A synchronous Runner startup throw bypassed the common completion cleanup and stranded its slot | Reproduced active count remaining 1. Make the event-boundary method async so synchronous and asynchronous failures share finalization; regression passes |
| LIFE-07 | Worker entrypoint acquired observability/DB before its cleanup scope; constructor failures leaked acquired resources and secondary errors were swallowed | Three regressions failed before. One ordered cleanup path covers partial acquisition, preserves primary/cleanup errors, and removes signal listeners; four lifecycle tests pass |
| LIFE-08 | Runtime swallowed drain/teardown errors and could overwrite its first fatal cause with a later control-channel failure | Reproduced a failed drain reported as successful. Attempt every owned cleanup in order, retain the aggregate error and first terminal cause; six entrypoint/runtime regressions pass |
| LIFE-09 | Runtime close could finish while startup was suspended; owner-stop also treated draining as proof of exit | Reproduced premature close before health completion. Join startup acquisition, latch stop at asynchronous boundaries, and join exact owner shutdown even during drain. Actual management HTTP regression verifies no stop proof until gated work settles |
| CLEAN-06 | Template registration retained unreachable kubectl forwarding/execution and an old v1-evidence bypass | All valid configuration branches already select direct Cube management. Remove unreachable mode/child cleanup and reject unsupported evidence explicitly; preserve missing-file first install. Syntax/install gates and actual template registration are the checks |
| DEPLOY-01 | Relay image build disabled networking although its pinned OS security updates require package download | Real deployment build failed against localhost proxy in the isolated build namespace. Match the other images' host build network; keep image-only runtime networking disabled. Relay image rebuild succeeds |
| TEST-02 | Template HTTP probe compared a real newline against literal backslash-n | Actual envd response was exit 0, expected marker plus newline. Correct only the expected bytes and retain response diagnostics; entire image probe rerun passes |
| MODEL-01 | Actual upstream 401/auth expiry was presented as generic retryable model failure | Provider adapter now emits a safe authentication-specific, non-retryable terminal without exposing upstream payloads; three regressions failed before, 33 adapter/Runner tests pass after. Included in deployed 9f62b365 |
| SUB-01 | A started Child Runtime rejected a mailbox message before its native Pi Agent was constructed | Paid workflow reproduced 409 and child cancellation. Join native Agent readiness before input delivery; bootstrap failure/cancellation settle waiting delivery without marking input consumed. Keep existing PG mailbox and native entry deduplication; no sleep/retry or second queue. Three delivery-mode regressions and paid 11-scenario repetitions at 5558ab15 and 9f62b365 pass |
| LIFE-10 | Cube Authorizer's async HTTP listener rejected an interrupted body outside any request error boundary | A real child process exited with ECONNRESET after its client disconnected. Catch only body-read failures and close that request without granting access; listener survives and the body-limit response remains covered |
| LIFE-11 | Provider relay opened an upstream even when its CONNECT client disappeared during DNS | Controlled-socket regression reproduced the late connection. Check the actual client lifetime immediately after DNS; no retry or new timeout. Five relay tests pass |
| LIFE-12 | Control Plane acquired telemetry/DB and constructed Subagents outside its cleanup scope | Four regressions failed before, including a real listener left open. Acquisition is now inside the cleanup scope; an unadopted Subagent controller is closed if Projector construction fails. Preserve primary and teardown errors. Four regressions and CP types pass; not yet deployed |
| LIFE-13 | Projector teardown stopped after the first failed drain, leaving its other owned resources open | Simulated relay/consumer failures reproduced skipped closures. Share one shutdown promise, attempt every owned close in dependency order and report all errors. Seven Projector handoff cases pass, including concurrent close; runtime types pass. No execution/order semantics changed |
| TEST-03 | Browser acceptance waited for text until timeout after an already-visible failed Run | Actual proxy failure reproduced the misleading 180-second wait. First-text wait now also detects the existing terminal error element and reports it immediately. Real repetition pending |
| ENV-01 | Deployed model relay retained localhost:10808 from an earlier shell, while the current proxy is localhost:12450 | Old port returned ECONNREFUSED before model execution. Owner selected 12450 permanently. Persist the explicit relay proxy in private .env; runtime Compose no longer selects it from generic shell HTTPS_PROXY. Installer/config tests and an opposing-shell-proxy render pass. Paid browser repetition and both model smoke calls pass through the selected proxy; provider credentials unchanged |
| CI-02 | New readiness barriers use ES2024 Promise.withResolvers while the shared TypeScript target remained ES2022 | CI caught the mismatch; earlier local checks had only started, not completed, so the initial pass wording above was corrected. Align the compiler target with supported Node 22.19+; browser keeps its explicit ES2022 library contract. All workspace types and remote CI at 9f62b365 pass |
| TIME-01 | Lease/claim timestamps were captured before potentially blocked SQL updates | Real PG reproduced a lock-delayed renewal reviving an expired lease. ADR-0170 is deployed at 9f62b365: issuance, renewal, validation and retirement use PG decision time; local deadlines are monotonic hints. Nine real-PG boundaries, local checks, CI and paid multi-round/Subagent/Worker-loss acceptance pass. Wider audit remains open; no post-seal corruption or tenant leak was demonstrated |
| PERF-01 | Sixteen concurrent Sessions with sufficient slots still spend substantial time before provider dispatch | Real sample: non-provider TTFT p50/p95 836/1,322 ms versus provider 1,036/2,071 ms; eight of 32 Turns are internal-time dominant. Worker metrics show claim averaging 122 ms. Investigate statement/lock/pool time before changing admission; no claim of full latency acceptance |

Latest browser repetition (`d923dbb9` Web, `9f62b365` backend/Workers): all 93
controls pass after temporarily pointing the relay at the available proxy.
Same-browser monotonic [Element Timing](https://w3c.github.io/element-timing/)
measured click → first actual text paint at **4,606.4 ms**, click → DOM text at
4,593 ms, and DOM → paint at 13.4 ms. The matching single provider sampling took
4,329.754 ms to first text; total non-provider click-to-paint was 276.646 ms.
This is one paid GPT sample in headless Chrome, not a concurrent-load percentile.
Sessions/Workspaces/machine, screenshots/downloads and browser profile were
removed; the two test identities remain in the campaign cleanup ledger.
Raw test-only Volume race evidence is retained privately pending the storage
decision; both temporary filesystem trees and database connections were cleaned.

Control Plane `5b8bd9aa` is deployed; its post-rollout GPT high/Fast and DeepSeek
high/Standard smoke Runs completed. DeepSeek API/SSE first text was 1,828.1 ms,
including 1,482.5 ms on the provider route; GPT's cross-process breakdown was
rejected because the host wall clock stepped, not used as a latency claim.
Full `npm run check` at this slice completed with **928 passed / two gated skips**
and all workspace type checks passing. LOCK-01 is a separate intentionally failing
private reproduction, not a skipped or solved regression. The owner requested a
detailed storage-contract discussion; no Workspace storage changes have been made.

ARCH-01 implemented locally: positive Agent exit and committed seal restore the
failed Session's admission, without changing the old failure or replaying Tools.
Both arrival orders pass; expiry-only, foreign-tenant and stale-old-attempt proofs
remain rejected. Only failure/cancellation persists the local exit confirmation;
normal completion adds no PG round trip. Exact owner-stop may also confirm exit;
an unreachable endpoint cannot. Browser fixture includes a cached failed Session.

GitHub's [setup-URL guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
explicitly requires checking the caller's access to the supplied installation;
ARCH-02 approved: remove the installation entry/callback, preserving ordinary
environment Git credentials and existing bound integration reads. No real GitHub
account or installation was probed. Local implementation follows ADR-0169.

Approved-slice validation: 352 tests passed across Control Plane/runtime/Worker/Web,
five external-PG-only checks skipped in that offline invocation. A dedicated real
PostgreSQL container then passed all nine queue/recovery cases plus concurrent
Run settlement (10 tests, 12.10 seconds). All workspace type checks, the Web build,
Chrome presentation interactions, documentation and Helm checks passed. Full
package tests with the isolated PG fixture finished: 877 passed, one schema-ledger
assertion still expected migration 138 and one live Cube test was disabled.
Updated that assertion to migration 140 and explicitly checked the removed table
and positive-exit column; all seven database tests then passed (878 corrected
package cases in total, one live Cube case pending). Five acceptance timing-helper
tests also passed. The isolated PG container and all its per-test databases were
removed; no formal users, Sessions or machines were deleted. These are not paid
model, deployed Cube or complete audit acceptance; production remains unchanged.
The maintained fault evaluator also passed all 26 targeted cases; its current
report distinguishes simulated protocol failures from actual local process kills.
No result here certifies physical multi-node failure or paid model behavior.

Remote CI passed completely at `aadcb725` ([run](https://github.com/cookerpapa/pi-cloud/actions/runs/34899010082)),
including the quality, browser and image/security jobs. Later slices require their
own final rerun; this is not evidence that paid end-to-end validation is finished.

Latest UI/resource slice: all 117 tests across 18 files pass, plus the actual
Chrome presentation/interaction fixture (including rejected clipboard cleanup).
These are local contract/browser tests, not paid model or deployed Cube acceptance.
Markdown follow-up: 126 Web tests and Chrome interaction checks pass. Synthetic
Node parser measurements (not end-to-end latency): parsing the whole 10,192-character
document each update had p50 18.96 ms; incremental suffix updates on a 10–11K
document had p50 0.41 ms / p95 1.12 ms. At 50–51K characters, incremental p50
0.73 ms / p95 1.24 ms. A single very large unresolved block still costs proportional
parsing work; these measurements do not claim constant-time arbitrary Markdown.
Control Plane follow-up: 134 tests passed, five real-PG-only checks initially
skipped by the offline suite and subsequently exercised below.
The dedicated PostgreSQL run subsequently passed all six checks across Workspace
admission/deletion races, concurrent settlement and indexed native-context queries
(16.26 s suite wall time). This is database integration, not full-stack recovery
or paid model validation. Its databases were dropped by the fixtures; the sole
owned test container and anonymous data volume were removed (absence verified).

Local regression slices passed: three
runtime-composition tests; 50 Worker/Runner/Harness tests; 12 auth/gateway tests;
69 Broker/admission/Tool-result/bootstrap/shutdown/monitoring tests. These slices
overlap earlier runs and are not a full-suite total. Native storage package: 92
offline tests pass, one real-PG-only plan test pending. Volume/RPC follow-up: 27
pass. Affected type checks passed. No paid/live
test was run in this campaign yet. Fixes are not deployed to the running stack yet.
Architecture-level issues block only their own modifications; continue
independent review and verification while awaiting the owner.

## Resources and final gate

### Approved authority-clock correction — TIME-01 / ADR-0170

Pre-fix renewal compared `valid_until` with an application timestamp sampled
before transaction/lock waits. Refreshing the timestamp earlier in the caller
does not remove pauses after that read or cross-machine clock differences.
The owner approved the fix. It keeps PG, Session-family Lease/Fence and Kafka seals,
but makes lease decisions use PG time at the locked decision point. Worker timers
remain local cancellation hints, not authority. It does not replay a Run/Tool or
relax seals. ADR-0170 is deployed at `9f62b365`; its paid acceptance passed.
Other audit items remain open, including UI origins, pre-provider latency,
remaining line review and combination tests. Resume v11 has not been changed.

Nine real-PG regressions pass: application clocks offset by ±1 hour; renewal,
grant and publication expiry during actual row waits; reaper clock independence;
startup-claim expiry during Session acquisition; delayed Broker renewal; a stale
retirement candidate after an earlier valid renewal commits.
Local observers use monotonic remaining lifetime including request elapsed time.
The unused absolute Supervisor lease deadline was removed. Delayed Broker renewal
also exposed overlapping timer requests; one in-flight heartbeat prevents them
from filling the connection pool. Fake-clock expiry tests now set explicit expired
database rows. The full suite is being repeated after those test corrections.
The repeated `npm run check` completed successfully with both real-PG fixture
URLs enabled. Format/docs/Helm/runtime-policy checks passed. The Worker startup
test's unrelated 500ms connection deadline was replaced with the production 30s
default after it preempted the intended publisher-failure injection; dedicated
expiry tests still use actual short-deadline lock waits. Local check recorded
919 passed tests and two environment-gated skips (standalone Cube and Kafka
integration gates); this is not a full audit completion count.

Deployed API, Worker and Broker image labels were verified at `9f62b365`.
Paid GPT Sol high/Fast and DeepSeek Pro high/Standard restored their markers;
first-text non-provider time was 290/360 ms (provider route 4,201/1,128 ms).
Two DeepSeek coding Turns passed sorting/search tests with a Worker change.
All 11 Subagent scenarios passed (16,007 input / 184,832 cache-read / 5,030
output tokens). Family acceptance also passed: a 62.73-second coding Run crossed
the initial lease lifetime; other families progressed; Worker SIGKILL caused
ordered family closure and replacement without repeating the old append.
Family usage: 14,071 input / 107,264 cache-read / 6,757 output tokens.
Its test conversations/Workspaces were released and both Workers restored to
four family slots/four model permits. New test identity rows remain in the
private cleanup ledger, together with the original baseline fixtures.
CI passed at `9f62b365` ([run](https://github.com/cookerpapa/pi-cloud/actions/runs/34930661277)).
The four old offline-node templates remain deferred, not falsely reported deleted.

### Live campaign started

Read-only pre-rollout inventory: 35 users, 33 tenants, zero Sessions/live Workspaces/
machines/active Runs/pending seals/pending Outbox. Preserve those identities.
Registered template catalog and service images at `2bc942b8`; applied migrations
139/140 with no user reset and rolled the idle stack. All services became healthy.
Four old template deletions were deferred by Cube with node-cleanup timeouts;
the four new templates are READY. Do not claim old template bytes were removed.

Paid diagnostic calls (small samples, not a throughput or statistical ablation):
DeepSeek Flash before rollout had one cold first-text sample of 5,062 ms, including
4,157 ms until model dispatch; a later sample was 645 ms (provider route 324 ms,
non-provider 321 ms). These baseline calls overlapped image build and are not an
idle-machine SLO. The first marker response was translated by the model, so its
exact-marker assertion failed; a clarified ASCII test passed. After rollout,
restoring the same Sessions on new Worker boots gave 1,087/1,157 ms for Flash
medium/Pro high, with 304/270 ms non-provider time. These are API/SSE receipt times,
not browser paint. Persisted model/reasoning/Fast snapshots matched the request.

Two paid coding Turns created and tested stable insertion sort, then read/preserved
it and added first-match binary search. Both completed, used different Workers,
one physical Workspace Cube and two Tool bindings (8 operations). Provider usage:
2,947 uncached input, 44,416 cache-read, 3,302 output tokens across those two Turns.
Final assistant text arrived after earlier Tool-generating sampling, so it is not
initial Agent activity. One Turn had a 1.57-second host wall-clock step; its cross-
process timing breakdown is explicitly unavailable, not silently used.

GPT initially failed upstream authentication: its configured access-only credential
expired and has no refresh token. Started the normal device authorization workflow
and asked the owner to complete it; no alternate credential was copied. Official
[Codex authentication guidance](https://learn.chatgpt.com/docs/auth) was checked
using OpenAI Docs. Product-surface GPT acceptance stopped on this actual failure;
it is not a passed test. First DeepSeek Snake coding completed, but the next
acceptance step failed because the shared API client lacked `getRun` (CLEAN-03).
The script released that test machine and conversation. Fixed the client contract;
42 API/view regressions pass after fixing the regression fixture's short token.
Full paid DeepSeek Snake repetition passed: 14 Tools/preparation activities,
1,198 ms first durable activity, 52,191 ms settled, isolated Preview HTTP 200,
and actual Chrome Start/movement/Pause/Reset assertions. The preview's tick advanced
0→5, remained 5 during Pause, and returned to 0 on Reset. Its machine and
conversation were released; aggregate evidence records deployed image `2bc942b8`
separately from the local harness revision. Test users still await final cleanup.
The first Codex device code expired; the owner completed a second normal device
login. A refresh-capable credential is now active and the expired access-only entry
was disabled via the management API. A paid GPT Sol high/Fast call recovered the
prior marker (first text 3,738 ms; non-provider 211 ms); DeepSeek Pro high/Standard
also recovered correctly (917 ms; non-provider 166 ms). No local Codex credential
was copied or modified.

Long-context acceptance passed against the normal 128K DeepSeek configuration:
13 algorithm-coding rounds and two threshold Compactions, at 112,473→26,824 and
112,297→24,935 estimated tokens. Early-marker recall, further coding, new Worker
restoration of the same Cube, GPT Luna medium/Fast search, and DeepSeek Pro
high/Standard search all passed. Native assistant usage covered 177 messages:
324,994 uncached input, 9,849,088 cache-read and 210,023 output tokens; excludes
unrecorded retries and Compaction usage. The harness's Git revision differs from
deployed runtime image `2bc942b8`; no claim is made that later UI fixes were deployed.
Its Session/Workspace were deleted and both Workers restored. Test identity cleanup
is pending. Current aggregate evidence comes from the private campaign log.

The re-run product-surface suite passed cookie login/logout, Fork/prune, coding,
bounded output, live browsing, terminal/Agent concurrency, two Sessions sharing
one Cube, Steer, cancellation recovery, cross-tenant denial, Workspace rebinding
and physical purge. Pure-chat first text was 2,330 ms: provider route 2,145 ms,
non-provider 186 ms. This remains API/SSE receipt, not browser paint.
Full real-browser acceptance passed 93 controls, including terminal commands,
model cascades, Steer/Stop, Fork/prune, directory creation, machine pause/resume,
SSH actions and resource deletion. Browser DOM-observed first text was 2,043 ms;
this is not a compositor paint measurement. The first browser run exposed an
obsolete terminal-label assertion and swallowed cleanup conflicts, not a broken
terminal. The script now executes a real terminal command and reports acceptance
and bounded resource-cleanup failures together. The successful rerun removed its
resources/screenshots; test identity rows still await final cleanup. Remote CI at
`d32a9fe7` passed; that revision's tree refresh fix is not yet deployed.
Private fixture IDs/credentials stay in `.cache/audit-live-baseline-state.json`,
not this report. The baseline and new test users/resources require final cleanup.

Live Subagent acceptance passed seven rounds: fresh/no-Tool, lazy Tool-capable,
parallel children, shared Workspace, isolated Branch, recursive tree and parallel
coding. Round eight reproduced SUB-01 rather than passing: immediate mailbox input
arrived during native bootstrap, received 409 and caused the workflow to cancel
its child. Local fix validation passed 97 Session tests (one separate real-PG plan
test not enabled in that invocation) and 104 Runner tests, including native
bootstrap failure/cancellation and duplicate delivery. Full deployed repetition,
supervisor interaction and child cancellation acceptance initially remained pending.
After deploying `5558ab15`, all 11 paid Subagent rounds passed, including immediate
mailbox delivery exactly once, parent decision/reply, cancellation and guest-only
workflow execution. Usage: 13,834 uncached input, 183,680 cache-read, 5,141 output
tokens. Four new templates became READY; four prior catalog templates were deleted,
while the same four older node-orphan templates still report cleanup timeouts.

Four tenants × two Sessions completed 16 real DeepSeek Runs with peak eight active
Runs, restored all eight markers and rejected eight foreign-tenant API reads.
No Tool calls or marker leaks occurred; each Worker handled eight Runs.
API/SSE first text p50/p95: 1,534/2,772 ms; admission 31/53 ms; queue 148/360 ms.
This is a bounded concurrency sample, not a saturation or browser-paint claim.
With the same eight slots, four tenants × four Sessions completed 32 Runs:
first-text p50/p95 2,406/5,109 ms; queue 683/3,552 ms; peak active Runs remained
eight. This is capacity queueing, not Kafka saturation. A temporary 16-slot/
16-model-permit configuration on each Worker is being tested separately;
restore the original four/four settings afterwards.
The first expanded-capacity wave completed all 32 Runs but was rejected as timing
evidence because the WSL wall clock jumped 1.744 seconds. A separate rerun passed:
16 simultaneously active Runs, no marker leaks, first-text p50/p95 1,904/3,209 ms,
queue 555/1,003 ms. Do not combine its clock-invalid predecessor into percentiles.
The remaining pre-provider delay is tracked as PERF-01, not blamed on the model.
Both Workers and the CP have returned to the original four-family/four-model
configuration and are healthy. A separate Kafka-only steady run on three brokers
published 747,520 records in 10.011 seconds with 1,024 synthetic Sessions:
74,668 records/s, ACK p50/p95/p99 12.17/22.39/28.09 ms. This excludes PG, Projector,
Tool execution, provider requests and browser rendering. Its temporary topic was
deleted; verify physical cleanup at the final inventory gate.
Remote CI at `7e929c67` passed all quality, browser and image/security jobs
([run](https://github.com/cookerpapa/pi-cloud/actions/runs/34920234169)).
The two owned old browser/Snake artifact directories were removed (about 500 KiB).
Original identities and formal logs remain untouched. New test identity rows,
the baseline fixtures and the isolated PostgreSQL container still require cleanup.

Real Control Plane/Projector SIGKILL during a paid DeepSeek stream passed on
runtime `5558ab15`: 41 Kafka records were produced after verifying the CP was
actually stopped; Worker boots did not change. SSE reconnected, the previously
visible prefix survived byte-for-byte, live text matched canonical history and
the Run completed with one Attempt (18.86 s total including outage/replacement).
This does not certify Worker death or physical multi-node failures. The probe now
measures its Kafka baseline after the kill and explicitly selects/reports the
tested model instead of reporting an unrelated tenant default.
Single Kafka-broker SIGKILL also passed with one Attempt, preserved prefix and
identical canonical/live text (23.84 s including recovery). No SSE reconnect was
needed in that run. Full Session-family fairness/Worker-loss rerun passed:
one Worker, two family slots, one model permit, five active tasks sharing two
family leases; another family progressed while three child Tools waited. Killing
the owning Worker closed the family before replacement, and the new Worker checked
the files/tests without repeating the old append. The first run stopped at an
over-strict exact-answer assertion although checks had succeeded; the rerun keeps
exact file/side-effect assertions and accepts explanation before the final marker.
Paid rerun usage: 11,799 uncached input, 107,904 cache-read, 5,213 output tokens.
Both Workers/configuration were restored; test conversations/Workspaces deleted.

Before mutation, inventory existing tenants/users/resources, image revisions and
configuration digests without disclosing credentials. Register test resources
explicitly. Delete only those fixtures after drain/seal/physical purge; preserve
formal diagnostic logs and real user data. Keep aggregate results, not raw
transcripts or credentials. Final CI checks, clean-state matrix, cleanup and
resume update are all pending.
