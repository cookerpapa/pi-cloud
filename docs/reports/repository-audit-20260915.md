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

## Coverage

Initial inventory: 922 tracked files. The large line count includes tests,
historical schema migrations, deployment and generated evidence. Dependency
lockfiles need dependency/CI validation rather than manual source review.

| Area | Code review | Runtime/combination acceptance |
| --- | --- | --- |
| Implementation map / README | Entry-point/data-flow map updated; detailed file coverage continues | Runtime inventory read-only |
| API, auth, resources, Run admission | Controller/auth/composition/store and machine service read; remaining resource/control services in progress | Local HTTP regressions only; live pending |
| Worker ownership, queue, capacity | Pending | Pending |
| Native log, Harness, Lanes, Compaction | Session backend package read; cancellation/projection-wait finding remains open | 92 offline tests pass; real PG plan case and live combinations pending |
| Kafka, projection, streaming and recovery | Pending | Pending |
| Tools, Cube, Volumes, machines, Preview/SSH | Broker/transport/Volume implementations read; Cube adapter and remaining lifecycle code pending | Owned local fault regressions only; Cube acceptance pending |
| Model routing/configuration and hosted search | Pending | Pending |
| Subagent lifecycle and communication | Pending | Pending |
| Frontend pages, controls and rendered latency | Pending | Pending |
| Configuration, deployment, migration, CI, monitoring | Pending | Pending |
| Scripts/tests/current docs and unused-code cleanup | Pending | Pending |

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
| UI-01 | Product/admin origin detection and redirects hard-code ports 8080/8081 | Source-confirmed configuration assumption; test supported custom deployment ports |
| UI-02 | Logout silently treated network failure as success and retained machine/dialog state in the mounted app | Browser reproduced false logout. Surface failure; successful/expired logout replaces the document so old account callbacks/caches cannot reach the next login |
| UI-03 | Composer and initial-prompt creation both sent `thinkingLevel: off`, overriding persisted Session settings | Real React/Chrome request-builder regression captured `off` in all three submissions despite medium/high selection. Remove obsolete overrides; GPT Fast/high → DeepSeek also tested without model execution |
| UI-04 | A terminal SSE arriving before the HTTP acceptance reply was reset to queued by `turn.accepted` | Reproduced; preserve terminal status while filling accepted prompt/Run metadata. Covers completed, failed and cancelled |
| UI-05 | Tree refreshes can finish after selecting another Session; new-chat/resource actions are not all guarded during pending mutations | Reproduce controlled response delays through the browser fixture before changing request lifecycle |
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
| SC-03 | Claim-note sync clears its pending bit before the external effect | Candidate lost notification after process death; validate crash and concurrent claim ordering before choosing the smallest durable fix |
| SC-04 | Issue credential authorization omitted the machine owner check used by ordinary Code Host connections | Reproduced successful preflight as another user in the same tenant. Share the existing ownership check before credential requests |
| SC-05 | Single-Issue mutation responses searched only the newest 100 jobs; list query fetched unused large Issue bodies | Reproduced durable claim followed by not-found after 101 newer jobs. Filter detail by tenant/ID and select only public summary columns; no Issue bodies in list reads |
| SC-06 | Optional GitHub App callback validates PiCloud state but not caller access to the supplied installation | Architecture decision ARCH-02 requested: disable the App installation entry or add GitHub user authorization; environment-local credentials are separate and remain unchanged |
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
| MUT-01 | Rebind and cancel check idempotency before acquiring their lifecycle row locks, then can reject on changed state | Candidate concurrent replay bug; reproduce with separate real PostgreSQL connections |
| LIFE-03 | Active Lane cold-history waits use the shared writer signal, not the task's cancellation signal | Candidate blocked cancellation; trace Runtime abort and test projection lag without poisoning sibling Lanes |
| CANCEL-01 | `abort()` was lost before the native Agent existed; cancellation during intent ACK still called the Tool | Reproduced model/effect calls after cancellation. Latched cancellation, checked the existing signal after intent commit, and kept aborted native outcome; unit regressions pass |
| CANCEL-02 | A local pre-sampling abort was classified as an assistant completion missing a Cloud Step | Reproduced through Runner; recognize the explicit no-sampling cancellation without inventing a Step. Runner/Harness suite: 48 pass |
| CANCEL-03 | Acknowledged cancellation failure changed business state but omitted the output seal and task-authority release | Reproduced missing Outbox terminal and zero release calls. Reuse failure closure in the same transaction; seven queue tests pass. Keeps the existing failed/quarantined Session state, not a successful cancellation |
| LIFE-04 | A destroyed publisher blocked every later claim but left the Worker apparently healthy forever | Reproduced no terminal signal after permanent failure. The log port distinguishes unreusable publisher failure from transient metadata outage; Worker stops local execution and signals process replacement only for the former. Readiness follows actual admission readiness. Seven transport/runtime regressions pass, including transient recovery |
| CFG-01 | Producer startup checks partition count but not existing topic replication/retention policy | Verify actual settings and configuration contract in isolated broker tests |
| MUT-02 | Tenant admission locks the smallest existing tenant UUID, which can change when a new tenant is inserted | Candidate concurrency-capacity race; reproduce overlapping registration transactions in real PostgreSQL |
| OBS-01 | Rejected metric collection escaped a native HTTP async callback | Reproduced a hanging scrape plus unhandled rejection. Return 503 for that scrape; next scrape succeeds |
| OBS-02 | Trace status used a safe error code but exception events still exported the raw message/stack | Reproduced with a synthetic secret in an owned error. Export only classification, rethrow the original error to its caller |
| CFG-02 | Control Plane parsed/mounted an unused dedicated PG notification URL | Deleted CP option/mount; Worker's actual LISTEN connection and bootstrap direct-PG settings remain |
| CFG-03 | CP/Broker/Volume Gateway rejected group-readable secrets while Helm mounts them 0440 under fsGroup | CP and Broker loaders reproduced failure with owned 0440 fixtures; aligned process-group read permissions while rejecting group writes/world access/symlinks. 44 Bootstrap/Broker/cleanup regressions pass. Actual Kubernetes startup and Volume Gateway child-process check remain pending |
| CFG-04 | Several private RPCs followed Node's global provider proxy, breaking Pod-IP/cluster routes | A real child process with an owned rejecting proxy reproduced Broker unavailability. Explicit direct dispatchers now cover Broker, Volume, Cube control, machine lifecycle and Worker enrollment; configured private GitLab routing is separate from public provider routing. A positive control confirms normal requests still use the proxy; 32 related regressions pass |
| DEV-01 | Machine creation checks replay before tenant lock; pause/resume replay treats a recorded request as a completed effect | Candidate concurrent create / failed lifecycle replay errors; reproduce after Broker lifecycle review |
| DEV-02 | Machine lifecycle descriptor requires an active Domain and non-failed environment profile, including release | Candidate inability to release resources in a drained/failed Domain/profile; check lifecycle contract and reproduce |
| DEV-03 | Broker concurrent duplicate machine provisioning created two provider runtimes; simultaneous first task bindings chose the same binding ID | Both reproduced. Reuse existing per-Workspace provisioning critical section for machine provisioning/binding creation, not Tool execution. Concurrent parent/child bindings now stay distinct and reuse one runtime |
| DEV-04 | Machine handle entered the ready map before durable state publication; failure destroyed the VM but retained that handle | Reproduced phantom active count. Publish PG state before installing the ready handle; clean failure no longer advertises a destroyed runtime |
| TOOL-01 | A reused persistent-machine binding could return a cached response belonging to an earlier Attempt | Reproduced by delaying old-body retirement while rebinding. Match the reader Attempt as well as binding ID; no PG round trip added |
| CLEAN-01 | Binding-local `materializing` was never written; old terminal-capacity transfer path had no reachable caller | Removed the field/branches/transfer method and its dead-feature test. Physical runtime materialization and concurrent Tool execution remain |
| CLEAN-02 | Native Lane exposed its private reader despite having no caller; one Fork test name incorrectly implied no payload copy anywhere | Removed unused getter; clarified shared query projection versus self-contained Fork log. No persistence semantics changed |
| CLEAN-03 | UI still polled Run state as a second pre-stream completion fallback | Removed poll/action/unused client method, matching the current seal-projection contract. Pre-start failure and late input ACK regressions cover this path; full live fault matrix remains pending |
| TEST-01 | Chrome helper selected a random fixed port, risking another browser under concurrent tests; debugger disconnect could strand pending RPCs | Use Chrome's allocated port from its own private profile, reject pending calls on disconnect, and report cleanup failures. Browser presentation/composer regression passes; parallel browser stress still pending |
| LIFE-05 | Broker HTTP listener remained open after provider teardown failed | Reproduced with actual local listener; close HTTP in `finally`. Eight RPC/server regressions pass. Also removed unreachable HTTP-side Tool timing branch; executor owns execution timing |
| FILE-01 | Trusted Git preflight discovered a Workspace's `.git/config` | Owned fake-SSH marker reproduced local config execution. Run network preflight outside user directories and disable global Git config; no real credentials or external server involved |
| FILE-02 | Credential reads followed a Workspace symlink outside its volume | Reproduced against an owned fixture; open non-following, nonblocking regular file and bound actual bytes read |
| FILE-03 | Browser path validation could race a parent-directory replacement before open/readdir | Reproduced outside fixture content/names. Validate the opened Linux descriptor and retain it for listing; bound reads if files grow after stat. Volume regression suite passes |
| PERF-01 | Git preflight held the Volume lock/PG lock connection during remote network wait | Reproduced blocked directory access; release after reading the credential, then perform the independent network probe |
| LOCK-01 | Volume advisory-lock connection failure is detected after the filesystem callback completes | Needs real PG disconnect + fork/delete interleaving proof; do not change storage/authority semantics without discussion if a local atomic-filesystem fix is insufficient |
| MEM-02 | Supervisor retained completed Assignments and publisher contexts, plus command/control bookkeeping | Reproduced 64 completed synthetic Runs retaining all 64 publishers and ~65 MiB of owned buffers with zero active Sessions. Clear the publisher at completion/pre-start release: zero publishers and ~1 MiB remain; completed duplicate commands still reuse their outcome. Long-term command/control/epoch bookkeeping retention remains under review |
| LIFE-06 | A synchronous Runner startup throw bypassed the common completion cleanup and stranded its slot | Reproduced active count remaining 1. Make the event-boundary method async so synchronous and asynchronous failures share finalization; regression passes |
| LIFE-07 | Worker entrypoint acquired observability/DB before its cleanup scope; constructor failures leaked acquired resources and secondary errors were swallowed | Three regressions failed before. One ordered cleanup path covers partial acquisition, preserves primary/cleanup errors, and removes signal listeners; four lifecycle tests pass |
| LIFE-08 | Runtime swallowed drain/teardown errors and could overwrite its first fatal cause with a later control-channel failure | Reproduced a failed drain reported as successful. Attempt every owned cleanup in order, retain the aggregate error and first terminal cause; six entrypoint/runtime regressions pass |
| TIME-01 | Lease/claim timestamps are captured before potentially blocked SQL updates | Probe delayed renewal versus actual expiry/seal with real PG; do not silently change the authority clock model |

Architecture question ARCH-01 (asked, awaiting owner): should a Session quarantined
after cancellation cleanup failure accept a new Turn after the old loop's exit and
committed seal are confirmed? Existing behavior only permits Fork/prune. No old
Run/Tool replay is proposed; ordinary failure-closure bugs are fixed independently.

GitHub's [setup-URL guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
explicitly requires checking the caller's access to the supplied installation;
ARCH-02 is awaiting the owner. No real GitHub account or installation was probed.

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

Before mutation, inventory existing tenants/users/resources, image revisions and
configuration digests without disclosing credentials. Register test resources
explicitly. Delete only those fixtures after drain/seal/physical purge; preserve
formal diagnostic logs and real user data. Keep aggregate results, not raw
transcripts or credentials. Final CI checks, clean-state matrix, cleanup and
resume update are all pending.
