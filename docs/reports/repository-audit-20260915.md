# Repository audit and system validation — 2026-09-15

Base: `1d7d7f8f`. Status: **in progress; not a full-review completion claim**.
Prior reports are historical evidence, not a substitute for this campaign.

Application-source reading is now covered by the private hash/range ledger;
tests, migrations, deployment/scripts and documents still have remaining reads.
This is coverage of reading, not a claim that every combination is already tested.

Portability testing reproduces a UID mismatch: Cube creates private Volume data
as UID 1000, while Compose ran its trusted reader as the host operator UID. The
owned filesystem fixture succeeds at UID 1000 and fails with EACCES at UID 12001.
Keep the reader at UID 1000 with the operator GID, its three mounted Secrets at
0640 and the Volume parent at 0750; preserve guest/identity ownership and modes.
The UID-1000/GID-12001 repeat reads both the Volume and its group-authorized
fixture Secret, without root/capabilities; all fixture directories are removed.
Share the bounded private-file reader across initialization and seven acceptance
scripts, remove the unused Gateway state directory requirement, and retain strict
checks for world/group-writable files and symlinks. Normal initialization and
Compose rendering pass; final deployment/product gates still apply.

Real paid k3d acceptance reached cross-Worker continuation, then a forced Runner
SIGKILL (kubelet exit 137) exposed a retirement bug: an invalid management response
permanently blocked the old owner, leaving the Run running past lease expiry.
The HTTP client classified non-JSON ingress 502/503/504 bodies as non-retryable
protocol errors. Three before-fix regressions fail; retain retryability for HTTP
5xx while still rejecting malformed successful responses. Nine targeted client/
server tests pass. The failed paid fixture is not counted as a pass; repair its
scoped cleanup and rerun the independent fault case after deployment.
After deploying CP `c28ce385`, the fresh k3d repeat passes: cross-Worker marker
recall, genuine exit 137, seal-before-successor and exact visible-prefix recovery,
plus four concurrent Turns across both Workers. Seven completed real DeepSeek Pro
requests report 591 input / 19,712 cache-read / 1,204 output tokens; the interrupted
request is excluded from that usage sum. The first fixture required requeuing
exactly its two blocked retirement jobs for cleanup; no Run was manually marked
successful or replayed. Kubernetes Workers run `ae5c5ff3`; this is a one-host
packaging/recovery result, not physical multi-node certification.

Remove the unmaintained `eval:coding` script and its otherwise unused manifest.
They call the retired `/runs/:id/test-results` endpoint (authenticated probe
returns 404), expect automatic sample-repository provisioning and leave their
fixtures behind. Current real coding/browser and deterministic runtime tests
remain; no production feature is removed.

Local Worker cutover had three rollback holes: a failure inside the CP switch
lost the caller's rollback state, a failed pool was not removed before Compose
restart, and previously stopped Workers were unconditionally started. Five
before-fix tests reproduce them. Capture the prior service states before changing
anything, await Helm removal and remaining Pod deletion, propagate shutdown
errors, and restore only prior running capacity. Additional contracts reject
Runs arriving during image builds and ready-but-old Worker images. Eight targeted
tests pass. The subsequent fresh k3d deployment exposed a stale bridge: CP
recreation changed its management IP, but Worker EndpointSlice/egress rules still
used the pre-recreation IP. The exact failure reproduces in a ninth regression.
Resolve dependency addresses after CP recreation. Stopping the failed readiness
wait exercised real rollback: remove the Helm pool and wait for executor Pods
before restoring Compose. This also caught an invalid `compose create --no-deps`
flag in the new stopped-Worker path; use `compose up --no-start --no-deps` instead.
The next run reached two healthy, enrolled K8s Workers but CP management probes
went through the provider proxy because local Worker hosts were missing from
`NO_PROXY`. Add the private Compose/Ingress hosts to the CP environment and check
them in the installer contract. This failed deployment rolled back successfully
with zero K8s executors and one running/one stopped Compose Worker. Final
successful deployment acceptance remains pending.
The final `ae5c5ff3` cutover completed with two Ready/enrolled Workers and direct
management reachability. A subsequent coding check was correctly rejected by the
Broker because a CP-only hotfix rollout advertised a newer environment revision
than the still-old Broker/template. This is a mixed-deployment rejection, not a
passing coding test; repeat on matching application images/templates. The same
review adds a downgrade regression: restoring Compose after an application
upgrade must retain the current CP image policy, not the old cutover snapshot.
The matched `b2cf34a3` deployment subsequently passes real Cube coding/Preview,
warm process continuity, tenant denial and a 1,025→1,026-file persistent-Volume
cold attach. Its 21 GPT requests record 30,602 input / 138,496 cache-read / 2,600
output tokens. The old script's “first durable activity” ignored Tool preparation;
annotate those historical numbers and use the shared current event predicate for
future samples. First assistant text and browser paint remain separate metrics.

The owner approved removing the old whole-system backup/restore entry rather
than building a new disaster-recovery system. Exact restore-code fixtures
reproduce 0755→0600 permission loss and rejected valid Workspace symlinks; the
scripts also require retired image tags/fixed optional Volumes and omit current
Kafka/Cube authorities. Remove the four scripts, npm/CI entries and unsupported
operating instructions. Deployment documentation now states the coordinated
backup boundary. No backup archive or real user data was deleted; Git retains
the old implementation. Earlier crypto-only passes are historical, not evidence
that the current system can be restored as a whole.

Further configuration tracing found that Worker runtime could read Producer limits
from ambient process.env, but Compose/Helm omitted them and the typed startup
configuration did not validate them. Three before-fix contracts reproduce the
gap. Load the shared capacity parser once, pass the snapshot to the bus/native
writer, and wire the same values into both deployment modes. Remove the unused
Producer retention parameter while retaining the actual Projector reaper grace.
Real R=3 overload/recovery offers 6,000 Facts: 4,037 acknowledged and consumed,
1,963 rejected before publication, 4 MiB bound respected and no pending data
after drain. Its elapsed time predates host-clock repair and is not accepted as
performance evidence. Native retention probes preserve low watermarks 0/5/20/20
through absent progress, an unsealed prefix, grace and database failure.

Host-clock diagnosis now identifies conflicting systemd-timesyncd and chronyd
clock_adjtime calls. The kernel tick was 9000–9220µs; an approved one-off 10000µs
trial was promptly overwritten. With owner approval, temporarily stop Ubuntu's
timesyncd (leave enablement unchanged) and retain WSL's PHC-backed chronyd.
Privileged chronyc reset commands were rejected and made no change; the remaining
daemon converged itself. The subsequent 140-sample/70-second comparison reports
Linux/Windows monotonic ratio 0.999880 and UTC offset 0–17 ms, with tick 10000µs.
Earlier timings remain excluded; final benchmarks must use fresh stable-clock
samples. No boot configuration changed. Clock adjustment follows the native
[adjtimex contract](https://man7.org/linux/man-pages/man2/adjtimex.2.html).

At `921450f8`, complete local CI passes 989 tests, two independent live skips,
26 targeted fault cases, four native Prometheus scenarios, and all deployment,
build/type/format/backup/security gates. GitHub CI also passed that revision.
The disposable real PostgreSQL database had zero remaining clients and was
removed. Twenty-three host clock steps exclude the new durations from performance
acceptance. No model tokens were spent by this deployment/monitoring slice.

All currently indexed ADRs and deployment manifests have now been read. Remove
superseded ADR-0109/0115/0149 from the maintained tree (Git remains their archive),
and align remaining decisions with shared-Volume compute, the Session-family
lease, Kafka-native append, asynchronous PG projection and no Workspace settlement.
Correct the Tool flow, GitHub credential boundary and shutdown-budget docs.
Remove the unused event.publish/event.ack process fixture and pending-commit
metric fixture fields; preserve actual Control Channel reconnection tests and
ensure their failed assertions still stop clients/processes. Full repository
test/script/migration coverage and final paid combination gates remain open.
After this cleanup, all eight focused Control Channel/sampler tests, affected
types, Helm/preflight contracts, documentation and formatting checks pass.

Platform deployment review reproduced incorrect Web upstream Service names,
missing Kafka/Volume Gateway egress, ignored external SSH dependencies and an
unreadable 0440 bootstrap Secret. Fix the existing chart, remove the retired
JetStream port, and add cross-component render assertions. Eleven owned K3s
before/after probes verify those interfaces, including a blocked negative-control
port. Web emptyDir permissions were also tested and already work; no extra Web
security-context change was added. An initial after-fixture omitted named target
ports and was corrected before the passing repetition. Both temporary namespaces
from each attempt were removed (the first cleanup wait timed out, then absence
was confirmed). These probes test real CNI/Service/Secret behavior with synthetic
endpoints, not Kafka throughput, paid models or full multi-node failover.

Distributed preflight previously changed namespace trust labels before checking
dependencies, treated namespace read failure as absence, ignored inherited
defaults/custom Worker Secrets, and missed required SSH/GitHub keys. It now reads
the rendered mounts instead of a parallel hard-coded list, checks only enabled
autoscalers/storage, and applies configured labels only during deploy after all
checks. Twelve CLI contracts use real Helm plus controlled kubectl; an owned K3s
namespace also passes valid/missing-SSH-key cases without changing its labels or
resourceVersion, then is deleted. Remove obsolete GitLab-login/object-bucket
schema and unused HPA fields; invalid settings now fail instead of being ignored.
Documentation no longer advertises unwired Kafka TLS/SASL or lag-based HPA.

Compose Worker startup also failed for non-default host identities: initialization
owned the private boot Volume with the configured UID, while the Worker retained
the image's fixed UID 1000. Actual isolated containers at configured UID 12001
reproduce EACCES on both boot state and private runtime directory. Set the Worker
service user to the same configured identity (inherited by the second Worker);
both writes then pass. All owned test Volumes are removed. Installer regression
also rejects unused network definitions; the unattached provider-egress network
is removed, while the actual model-egress/host-relay path remains unchanged.

The local k3d Worker helper omitted Kafka and Provider Gateway bridges. An owned
native K3s namespace running the previous generated Service resources can reach
Control Plane but not the gateway or any of the three actual Kafka-advertised
hosts. Add their endpoint bridges and Worker-namespace aliases; the same five
read-only network probes then pass. Extract the maintained connection manifest
so Helm regressions exercise it directly, including customized family/model/PG
pool/Child limits and Kafka partition count. No production Worker cutover was
performed here; full fresh k3d install/enrollment/paid acceptance remains pending.

Native Prometheus rule tests reproduce a healthy replica hiding another replica's
stale or never-successful sampler. Evaluate freshness per instance; missing-sample
alerts now select each reachable Control Plane, while unreachable targets retain
the existing target-down alert. Four deterministic rule scenarios pass using the
same pinned Prometheus image as deployment, and now run in CI. Correct misleading
dashboard labels: cached partial events are not PostgreSQL projection lag, and
the Kafka-labeled local statistics sample is not a broker health probe. Temporary
rule-test storage stays in container tmpfs and is removed with the container.

Further actual-Chrome regressions reproduce and fix four UI lifecycle errors:
New Chat could reset a pending input submission; a read-only Child opened a
Workspace-rebind dialog; identity-service network/503 failure falsely rendered
login; and a delayed pre-deletion list resurrected the parent and its children.
Guard pending navigation, keep Child rebinding disabled, distinguish unavailable
identity from genuine 401 with a working reload action, and apply only the latest
conversation-list response. Normal parent Fork/prune/rebind and 401 login remain
covered. Remove the uncalled environment-refresh reducer action and unused text
recovery argument. Browser checks, 135 Web tests, types and build pass. Web is
deployed at `bb217be0`; an actual deployed Chrome check blocks the identity
request, verifies the unavailable view, retries after restoring the network and
gets the genuine 401 login form. Remote CI at `bb217be0` and `7d4e23e7` passed.

Tree fixes are deployed in Control Plane at `352ace33`. The final paid DeepSeek
check completes three ordinary Turns and two Child Runs, validates inherited and
fresh context/tree bindings, human Fork recall, actual Chrome child read-only
actions, missing-Workspace Fork/replay, and leaf-first cleanup. Recorded usage:
1,399 input / 16,128 cache-read / 353 output tokens. All three repetition Volumes
are purged, their fourteen task/conversation views archived, and no active Run
remains. No Cube was activated by these Tool-free children. One earlier helper
cleanup redundantly re-deleted parent-archived forks; another earlier repetition
failed model recall. Native context reconstruction retained the exact identifier;
the first prompt's loose substring assertion had accepted a quoted refusal.
The final check uses unambiguous literal identifiers and exact equality. Earlier
failures remain recorded, not merged into the passing run or a success rate.

The next full CI exposed a terminal-close race: overload sent a Close frame then
immediately called `terminate`, sometimes exposing code 1006 instead of 1009.
Do not terminate a socket already closing; the existing ws library owns its
bounded handshake timeout. Both byte/frame overloads reproduce forced termination
before repair. Thirteen Broker RPC tests/types and eight repetitions of four
terminal cases pass after repair. Broker is deployed at `5839d508`; complete
local CI on that revision passes 989 tests, two independent live skips, 26 fault
cases and build/type/docs/Helm/install/backup/security gates. Two existing moderate
Vitest dependency findings remain; the high/critical gate passes. Twenty-two host
clock steps were observed, so new timing values remain excluded. The temporary
PostgreSQL container was removed after confirming no test clients remained.

Worker chart review reproduced a custom metrics Secret key mapping to a nonexistent
subPath. Mount the fixed projected file path, like the other secrets, and cover all
custom key names in Helm rendering. The standalone chart now pulls missing images;
the local K3s helper already explicitly selects Never after image import. Worker,
platform and distributed-values checks pass. This is render/contract evidence,
not a fresh multi-node Kubernetes deployment claim.

Further September 16 review reproduced terminal input delivered after its socket
closed. Bound the existing serial queue (1 MiB / 128 frames), keep control-frame
reads live, and discard queued work after closure; already-issued effects are not
retroactively undone. The machine-terminal Gateway also fell through to elastic
routing for a same-tenant non-owner. Restrict elastic descriptors and Broker
reservations to user Workspaces; keep the owner-only machine endpoint. Before
regressions showed a third post-close input and an incorrectly successful elastic
admission. Eighteen focused cases pass, including the real-PG reservation test;
full local CI passes 981 tests, two independent live skips and 26 fault cases.
Matching runtime and templates are deployed at `c5455d5b`. Paid product-surface
repetition passes twelve Runs (eleven complete, one deliberate cancellation),
including real Terminal/Agent concurrency, shared-Workspace Tools, normal
Fork/prune, Steer, rebinding and cross-tenant denial. Recorded native usage is
46,794 input / 140,288 cache-read / 729 output tokens. All four conversation views
are archived and three fixture Volumes are physically purged; final campaign
identity/history cleanup remains pending. Recorded timings are explicitly excluded
from performance acceptance because of the host-clock fault below.

Cube Authorizer now runs the same revision in two K3s replicas. Six deliberately
interrupted HTTP bodies leave both replicas healthy with unchanged Pod identities
and restart counts, closing the pending LIFE-10 rollout check.

All twelve stale Cube templates are now removed via native deletion after bounded
operator correction of their stale replica/placement node addresses. Current
four templates/artifacts remain. This fixes accumulated resources, not Cube's
upstream preference for historical Pod IPs. The published Cube 0.7.1 introduces a
separate template service/storage changes; it was researched, not silently adopted.

Temporary clock tests compared Windows and WSL over approximately 70 seconds:
Linux monotonic/Windows elapsed ratios were 0.9149 (`tsc`), 0.9120 (Hyper-V page),
0.9161 (Hyper-V MSR) and 0.9139 (`acpi_pm`). Two ordinary observations of the active
NTP server independently measured 65.780 s externally versus 60.287 s locally.
Every trial was restored to `tsc`; no startup configuration or clock daemon was
changed. Windows time service reports an unsynchronized Local CMOS source, but
that is not a proven cause. Host-time remediation and reliable new latency claims
remain open. No timeout was increased to conceal this issue.

Tree review is ongoing: a retained audit Session with one failed and fourteen
successful Turns reproduces a user-entry/Turn mismatch in navigation. The ordered
message-count heuristic is now removed in favor of the existing durable Turn
binding. Tree entries/heads/Turn status use one repeatable-read snapshot, and
human Fork logs retain inherited bindings for projection rebuild. Seven real-PG
regressions reproduce the pre-fix failures and pass after repair: failed prompt
misassociation, unsealed answer replacement, multiple answers within one Turn,
Fork/rebuild binding loss, concurrent tree publication, and two missing-Workspace
Fork response cases. Types and the existing registration/Fork/prune/Subagent tests
pass. Full CI found one older Child-tree fixture incorrectly attributing an
unbound earlier parent prompt to the Child Turn. Seed an actual completed parent
Turn and a separate Child prompt, and require exact IDs for all four navigation
entries. That eleven-case file and its types now pass. Full CI repetition and
deployed paid checks remain pending; the failed first CI is not reported as green.
The Fork/rebuild regression was then strengthened to compare complete parent
transcripts before and after rebuilding the child's projection. It reproduced
duplicated parent text once inherited entries retained their Turn IDs. Canonical
message/intent and interruption-prefix reads now select only the Turn's actual
execution Session; copied history cannot become another output producer. All 36
focused tree, Child and seal cases and the affected types pass. The second full
CI was deliberately stopped before editing; final repetition is still required.
The owner chose read-only
child views rather than adding human Fork-from-Lane semantics. The actual Chrome
test reproduces enabled child Fork/prune buttons before the fix; after the fix,
inherited and fresh children disable both actions, attempted clicks issue no
mutation, and returning to the parent restores ordinary actions. No state-model
or human Fork-from-Lane semantics change has been made.
The 135 Web tests, type check, build and documentation check pass for this UI
slice. Its browser profile/Vite cache and the idle temporary PostgreSQL container
were removed; no production database or user content was deleted.

ADR-0172 implementation now delegates Volume initialization to Cube's Controller
plugin, with one immutable identity; Gateway verifies only. Removed the two-file
initialization state and metadata-presence-driven guest setup. Guest seed
publication fills missing files without deleting/replacing user bytes. Native
plugin tests pass for 20 concurrent Creates, SIGKILL before/after publication,
unchanged Attach/Detach and generation-bound deletion faults. An actual-PG
regression also prevents retiring another tenant's terminal; model-lookup cleanup
and encoded machine-capsule bounds have targeted regressions. Full local CI now
passes: 978 tests, two independent live skips, 26 fault cases and all build/type/
deployment/security gates. Actual Chrome presentation checks also pass. The first
run had one Vitest timeout (1,551 ms reported against a 5,000 ms limit); its full
15-case file passes separately. An isolated clock-step probe reproduces Vitest 3's
wall-clock completion guard rejecting a 56-ms test. The full rerun observed 20
host clock steps of +2,859 to +3,565 ms; timesyncd reports a 32-second poll and
about +2.86-second correction. Original-failure causation was not directly
instrumented. No timeout/vendor patch or host-clock change was made. This run is
functional evidence, not a trustworthy latency benchmark; clock remediation is
an operator prerequisite for new performance acceptance. Two existing moderate
Vitest dependency findings remain; the high/critical gate passes.
Old baseline test Volumes were retired through the ordinary deletion API and
confirmed physically purged. No unpurged Workspace or unreleased machine remains;
accounts/history are retained. The operator subsequently updated the Controller
plugin; matching CP/Worker/Broker/Gateway/Web and guest templates are deployed at
`18e96210`, with all services healthy. Four paid DeepSeek Pro Runs and twelve
Tools pass: insertion sort, binary search, warm reuse, explicit compute removal
followed by cold reuse of identical file bytes/Volume identity, then another
Session sharing that Workspace. Usage: 9,364 input, 58,240 cache-read and 3,386
output tokens. Three additional live API waves of twenty concurrent first-use
requests each verify one initialized Volume; all sixty requests pass. Both
conversation views are deleted and the coding Volume plus three direct-API test
Volumes are physically purged, with no cleanup error. The original fixture
account/history remains for the unfinished campaign. Twelve old Cube templates
still fail native cleanup against their old node locator; no claim of completing
that cleanup. Whole-repository review, final combined acceptance and resume work
remain incomplete.

September 16 continuation: a held retirement query reproduced Worker shutdown
waiting before queue admission stopped. Join that background read only before
destroying its pool, after stopping admission and draining Runs. The regression
also requires shutdown to wait for that query before returning. Full local CI
on `611df027` plus this repair passes: 972 tests, two independent live skips,
26 fault cases, build/types/docs/install/Helm/security gates. The existing moderate
Vitest findings remain; no high/critical dependency finding is ignored.

DeepSeek capability diagnosis corrected an overly broad initial conclusion:
Flash's current Responses route ignores even forced native search; Pro Responses
and Flash Anthropic return real search events/results. Direct and gateway probes
agree. The owner chose to hide Flash rather than change protocols or add a search
tool. `611df027` is deployed to CP/Web; 219 related tests and actual Chrome
catalog/selection/reload checks pass. Stored Flash selections are not rewritten.
Worker remains `4dc24f4e`; the drain repair has not yet been deployed.

The latest Tool-adapter slice reproduces a Hosted Search ordering defect:
two trailing searches sharing a preceding anchor replayed in reverse order.
Append within that search group instead; anchored/trailing and idempotent replay
regressions pass. The old remote-Tool Extension entry point had no production
caller. Removed it, its emulated Extension API/handler registry and unreachable
CLI Bash hook; kept the same Pi factories, policy/Step checks, commands, result
reads and output handling. Ported tests to the actual Agent Tool factory and
renamed the files to `trusted-remote-tools`. One duplicate registration-only test
is removed. Supervisor tests pass (112); types pass. Worker `4dc24f4e` completed
two paid coding Turns (seven Tools), plus GPT native search and GPT/DeepSeek
context-recall handoff. The Flash search acceptance failed because that native
Responses capability is no longer served; it is not reported as a passing test.
The final combined audit matrix remains pending.

MEM-02 continuation: completed command/control/family bookkeeping is released
by a minute-period Worker maintenance task only after PG proves terminal Run,
projected seal and terminal control requests. One indexed, bounded lookup batch
replaces per-Run queries; this is not on the model/Step/event path. Local tests
cover unavailable PG, unconfirmed outcomes, superseded-but-unjoined Runners,
concurrent newer owners and pre-start bookkeeping. An isolated GC probe retains
16 command objects before confirmation and zero afterward. The SQL matrix covers
108 combinations of Run state, seal and control state, plus missing authority and
1,001 lookup IDs. Migration 142 adds only a pending-control index, no data reset.
At `32e40930`, full local real-PG CI passes (967 tests, two independent live
skips, 26 fault cases), as does [remote CI](https://github.com/cookerpapa/pi-cloud/actions/runs/35046644510).
The Worker and index migration are deployed; CP remains `bcb400a3`. Five paid
Runs pass: concurrent Steer/replay, two coding Turns with six verified Tools,
and GPT high/Fast plus DeepSeek Pro high recall/configuration. A fresh Worker's
retained Run/control/family counts reach zero before the Steer API replay; later
coding and provider batches also return to zero. Usage totals 40,347 input /
315,904 cache-read / 1,830 output tokens. DeepSeek chat first text is 1,530 ms,
provider route 1,254 ms, internal 276 ms; this overlaps local CI, not an idle SLO.
GPT's split timing is excluded due to a 3,375-ms host-clock step. Baseline fixtures
are retained for the audit; no new account or Workspace was created.

Further Harness review reproduced controls stranded by failed model/Session
preparation: the Run had already failed while both Steer and child input remained
pending. Finalize control waiters at the whole-Run boundary, including startup;
late input is rejected immediately. Both failure regressions and all 111
Supervisor tests/types pass. Removed the unused synchronous Step-capture branch
and old Extension-API settlement implementation; their tests now exercise the
actual asynchronous capture and production settlement controller, preserving
the optional verification behavior. Worker `0b66e469` is deployed and another
paid DeepSeek Steer/replay-after-retirement passes (3,878 input / 70,912 cache-read /
515 output tokens). The temporary actual-PG fixture is removed; older campaign
fixtures remain for unfinished acceptance. Full audit and final combination gates
remain open.

At `1209d458`, five deterministic multi-replica Steer races pass after
fixing unchecked zero-row terminal updates and late transport replies. Before
the fix, three cases reproduced false failure, false success and an invented
delivery timestamp. PG remains the authority; normal delivery adds no SELECT,
terminal retries do not contact the Worker, ambiguous nonterminal replies remain
unknown, and database errors are no longer silently suppressed. Full local CI
passes with real PG: 959 tests, two separate environment skips and 26 fault
cases; [remote CI is green](https://github.com/cookerpapa/pi-cloud/actions/runs/35044213651).
The Control Plane rollout and paid DeepSeek Steer pass: two concurrent same-key
requests share one result, the model follows the new instruction, and a replay
after completion preserves the original delivery timestamp. Usage is 30,446
input / 35,072 cache-read / 52 output tokens. This reuses the campaign baseline;
its temporary sleep exits without modifying files.

The next control-channel slice reproduces two additional failures using real
WebSockets and the PG-backed registration manager. A delayed registration reply
after disconnect could kick the replacement socket, or resurrect a closed entry
after shutdown. Rechecking transport liveness after registration prevents both;
15 related Steer/channel tests and Control Plane types pass. The network matrix
also no longer documents the removed Fact Gate or a separate Broker Kafka consumer.

The earlier `f312b3a8` CI browser failure was a fixture race, not evidence that
the newer green CI repaired it. Opening the dialog before Workspace loading
finishes correctly selects new-Workspace mode, but the test submitted only a
title. Holding/releasing the list response reproduces the invalid form. Explicit
Workspace selection fixes the harness without changing product behavior; the
full Chrome presentation check passes with that delayed-response scenario.

The phase-instrumented Workers (`f312b3a8`, CP `211767bd`) complete 16 further
paid DeepSeek Runs across four tenants/eight Sessions, with eight simultaneous
Runs, eight successful marker restores and no cross-tenant leaks. Usage is
3,026 input / 25,600 cache-read / 2,940 output tokens. API/SSE first-text p50/p95
is 1,756/2,707 ms; queue wait is 390/1,017 ms. Successful claim averages 200.5 ms:
begin 1.4, selection 45.7, context 86.5, configuration 8.0, ownership 39.8,
lifecycle writes 8.7 and finish/commit 10.3 ms. These are sixteen-claim means,
not per-stage p95; selection/ownership each include several SQL operations.
The evidence does not support attributing the full delay to WAL commit. PERF-01
remains open; detailed claim timings do not change admission or lease semantics.
These four new load tenants and all their Run/Session/Workspace metadata were
removed after purge checks and a FK-enforced rollback rehearsal. No active Runs
remain; the temporary second Worker is stopped again. Older campaign fixtures
remain until the unfinished audit's final cleanup.

September 16 continuation: remote CI for `7b5b7587` is green. Isolated actual PG
profiling with `pg_stat_statements.track_planning` confirms the two main claim
queries spend substantially more time planning than executing. Scalar-subquery
rewrites did not show stable benefit and were reverted; no planner GUC changed
in production. A pg-native named-statement experiment improved claim latency.
Kysely's maintained Postgres.js dialect was evaluated but rejected for direct
adoption: its JSON parameter serialization changed an existing recipe into a
JSON string. Keep the current pg driver, encoders, pool errors and no-retry behavior.
The shared adapter now bounds named SELECTs to 128 per connection. Actual PG
regressions cover changing values/JSON/int8, cache exhaustion, transaction rollback,
idle reconnection and in-flight cancellation with a one-connection pool.
The first full run found shared-backend statement-name collisions in PGlite
boot-provisioning tests and was stopped after retaining the failures. Names now
use a per-client namespace and bounded ordinal, not a SQL-only hash shared across
clients. The two-client regression and provisioning regressions pass. Fixed
`211767bd` completes full local CI (953 passed/two separate live skips, 26 fault
cases), build and [remote CI](https://github.com/cookerpapa/pi-cloud/actions/runs/35037255930).
Control Plane, both Workers, Broker and Volume Gateway were deployed at that
revision; Web/Cube templates remain `97995c0f` because their code did not change.
References: [pg named statements](https://node-postgres.com/features/queries#prepared-statements),
[Kysely-maintained alternate dialect](https://github.com/kysely-org/kysely-postgres-js).

Controlled A/B at `9ff24b0b` uses fresh databases, identical 48-Run waves, four pooled
connections, a two-CPU/768-MiB PG container, default planner settings, and the
same real Run admission/settlement code with a no-model backend. No Kafka/Cube
or model time is included. The after case uses the actual `createDatabase`
implementation, not the earlier two-query prototype. This is one paired sample,
not a deployment SLO or a universal claim about all SQL workloads.

| Concurrent dispatch calls | Before claim p50/p95 (ms) | Prepared SELECTs p50/p95 (ms) |
| --- | ---: | ---: |
| 1 | 41.5 / 52.0 | 27.8 / 54.0 |
| 4 | 77.5 / 103.1 | 54.0 / 116.6 |
| 16 | 260.3 / 397.9 | 110.3 / 161.0 |

At 16, the context query plans 48 times before and zero times after its prior
warm-up waves. Cold low-concurrency p95 did not improve in this sample; no claim
that every individual request becomes faster. The later client-name correction
does not change query text, parameters or the named-plan policy.

Paid `211767bd` repetition passes six baseline Runs (GPT high/Fast and DeepSeek
settings/recall plus two coding Turns on different Workers, seven Tools) and
16 further Runs across four tenants/eight Sessions. Both Workers handle eight
load Runs; eight markers restore correctly, eight foreign reads return 404,
and there are no marker leaks, unexpected Tools or extra Attempts. Native usage
across these 22 Runs is 38,551 input / 304,896 cache-read / 4,945 output tokens.
Load first-text API/SSE p50/p95 is 1,684/2,550 ms, queue wait 418/842 ms, and
non-provider time 786/1,149 ms. **Ten of 16 load Runs remain internal-time dominant**:
PERF-01 is improved at the query-planning layer, not closed as a system SLO.

A baseline on the previous image exposed a separate one-time opening delay:
`execution_opened` was created at 23:47:05.509 UTC and appended by Kafka at
23:47:08.552; Worker `log_open` measured 3.14 s across its first two Runs.
The later single Producer-initialization probe took 12 ms. A separate owned-topic
experiment could not reproduce the three seconds or attribute it solely to PID
initialization; no speculative Kafka prewarm change was shipped. That topic was
deleted. A subsequent paid Run showed a 3.15-second host wall/monotonic mismatch;
its split timing is excluded, though its functional result passed.

The four load tenants, 16 Runs, eight native Sessions/views and four Workspaces
were removed after physical-purge checks and a FK/check-enforced rollback rehearsal.
The older campaign baseline remains for unfinished acceptance. The temporary
second Worker returns to its initial stopped state; the normal first Worker
remains running on the new image. Shared Kafka records follow existing safe
retention, not an unsafe selective partition deletion.

Build/test-tooling slice: a scratch Docker fixture reproduced private/generated
paths being re-included by broad directory exceptions in `.dockerignore`.
Narrow build-input patterns retain all local inputs across ten Dockerfiles
and exclude all 14 canaries. Only harmless placeholder contents entered this
probe; no real secret was exported. The check is now an explicit CI gate.
A real Chrome target-close test also reproduced an RPC hanging when sent after
disconnect. Reject closed-socket sends and handle send errors; the disconnect
regression and all existing browser presentation assertions pass. Temporary
profiles, Vite cache and build-fixture directories are removed. Runtime images
are unchanged by this tooling-only slice; final combined acceptance remains open.

At `8e6cad2b`, the complete local `npm run ci` exits successfully: 953 tests pass,
two separate live gates skip, and types/build/format/docs/deployment/fault/backup
checks pass. The standalone actual R=3 Kafka policy test also passes, including
seven valid/invalid topic configurations; its temporary topics are absent afterward.
The dependency audit passes its high-severity gate, but still reports moderate
development-only Vitest/mocker findings; this is not a zero-vulnerability claim.
The remaining `runtime-core` and `supervisor-host` files/tests have now been read.
An uncalled Bash test-classifier and its three self-only tests are removed in the
following cleanup; the 953 count belongs to the preceding fixed revision.

Cleanup revision `b0cbd2c7` also completes a fresh real-PG `npm run check`:
**950 pass / two live gates skipped**, exactly three fewer self-only tests.
Format/build/docs and the real Docker context check pass (462 retained inputs).
The standalone Kafka policy gate passed separately; the Cube-only gated test
is not counted as passed here. Remote CI for this revision was still running
at handoff. The isolated tmpfs PostgreSQL fixture had zero test databases and
zero other client connections before removal; no persistent Docker Volume.
No new product account or Workspace was created by the four reused-baseline Runs.

Four more paid baseline Runs pass on deployed `ea4ae725`: GPT high/Fast and
DeepSeek high restore their saved settings/marker, followed by two DeepSeek coding
Turns on different Workers (seven Tools; insertion/binary search assertions pass).
Native usage totals 27,549 input / 217,088 cache-read / 1,734 output tokens.
Chat first-text API/SSE receipt is 3,777/1,819 ms, provider 3,421/1,565 ms and
internal 355/254 ms. These two observations overlap local CI, not an idle SLO.
Coding first text follows earlier Tool sampling, so it is not initial model TTFT.
The reused audit baseline is retained for the unfinished campaign's final matrix.

Previous runtime: Control Plane/Workers/Broker `ea4ae725`, existing Web/Cube template
`97995c0f`. **953 tests pass / two separate environment gates skipped**, with real
PG enabled; types/build/format pass and [CI is green](https://github.com/cookerpapa/pi-cloud/actions/runs/34979016595).
During a paid DeepSeek stream, the test Worker was paused for 357 ms to select
and terminate one confirmed idle PG backend, then resumed. Its boot did not
change; the Run completed with one Attempt, unchanged visible prefix and identical
live/canonical text (19.735 s total; 230 input / 2,432 cache-read / 2,820 output
tokens). No arbitrary query was replayed. All fixture metadata was removed.
The paid product-surface rerun also passes login, Fork/prune, coding, bounded
output, Terminal/Agent concurrency, shared-Workspace Sessions, Steer, cancellation
recovery, tenant denial, rebinding and purge. Its two accounts, 12 Runs, four
views/native Sessions and three Workspaces were removed. Full audit/resume remain open.

Broker `6a718115` is deployed. Actual Cube pre/post-upload cancellation and
same-VM continuity pass, as do two paid DeepSeek coding Turns (eight Tools,
3,053 input / 226,560 cache-read / 1,851 output tokens). Four tenants/eight
Sessions complete 16 paid Runs, with eight marker restores and eight foreign
reads denied; no marker leaks or Tool calls. Both Workers handle eight Runs.
The 7,177 input / 21,504 cache-read / 3,035 output tokens are native usage.
This load overlapped an isolated SQL diagnostic; its timing is not an idle SLO.
All four new load tenants and both adapter-fixture projects were removed after
archive/purge checks and FK-enforced deletion rehearsal.

Earlier directory slice: Control Plane `f561e041`; Workers/Broker/Web and Cube templates
`97995c0f`. Actual Chrome directory selection/creation now passes for long ASCII
and 255-byte Chinese names; oversized input returns 400. All three directory
fixture accounts, projects, machines and Volumes were removed after purge.
Post-rollout GPT high/Fast and DeepSeek high recall pass on a new Worker boot;
API/SSE first text 3,848/1,355 ms, provider 3,537/1,004 ms, internal 311/351 ms.
These two samples overlapped local test work and are not an idle latency SLO.
The fixed-revision `f561e041` check completed with **944 passed / two independent
Kafka/Cube gated skips**, both real-PG URLs enabled. Types, build, format and docs
checks pass; [all CI jobs passed](https://github.com/cookerpapa/pi-cloud/actions/runs/34969677689).
The owned tmpfs PostgreSQL container was removed after zero remaining test
databases/connections were confirmed. This is not final repository-audit acceptance.
Post-rollout two-round DeepSeek coding also passes on different Workers with
eight Tools: retained insertion sort, added/verified first-match binary search,
and ran both Python suites against the existing Volume. Usage: 3,261 input /
187,264 cache-read / 1,645 output tokens. One host-clock-stepped stage breakdown
is excluded; final text followed earlier Tool calls, not the initial sampling.

Earlier slice (`642878b9`) fixes task-scoped cold-read cancellation, machine lifecycle
confirmation and machine Session defaults; removes unused Domain surfaces.
`npm run check` passes 917 tests with 25 explicit live/PG skips; a separate real
PostgreSQL run passes 24 cases. The paused-projection Parent/Child Host regression
also verifies cancelled cold reads, valid final writes and replacement-Host recovery.
Control Plane, both Workers and Web are deployed and healthy. Two machine
acceptance repetitions pass; the first inherited a fake provider for its first
two coding Turns and is excluded from paid-coding evidence. The corrected rerun
uses DeepSeek for two coding Turns and GPT for two parent/two child Runs: all six
complete, with 26,257 input / 81,280 cache-read / 2,116 output tokens. It validates
starter-profile inheritance, home-directory default, old-pause replay, same-Volume
temporary compute, separate same-port Preview, SSH, pause/resume, Broker restart,
process continuity and machine/Volume removal. The rerun includes the explicit
DeepSeek test-script change made after the named deployment commit.

Two additional DeepSeek coding Turns pass seven Tools and both Python suites.
One timing sample is excluded from stage analysis because WSL wall time jumped
696 ms. GPT high/Fast and DeepSeek high recall probes pass with persisted
configuration; the GPT Turn runs on a different Worker from its preceding coding
Turn. First-text API/SSE receipt is 3,293/2,003 ms, provider-route first text
3,103/1,816 ms and non-provider time 190/187 ms. These are two observations,
not percentiles or browser-paint measurements. No full-audit completion claim.

[ADR-0171 acceptance](subagent-compute-20260915.md) retires the LOCK-01 copy path
through owner-approved shared-Volume compute scopes. The `fd07a098` guest templates
remain compatible; Broker/Volume Gateway run `b84ecb30`. Its paid fixtures are cleaned;
the older audit baseline and remaining review gates are still open.

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
That earlier Web deployment's configuration endpoint returned the expected
local origins. Runtime configuration is evaluated only
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
| Native log, Harness, Lanes, Compaction | Session backend package read; task-scoped cold-read cancellation fixed | Real-PG plans and cancelled cold reads; two native Compactions during 13 coding rounds; combined child/Compaction coverage still incomplete |
| Kafka, projection, streaming and recovery | Producer/startup policy and selected projection/seal paths reviewed; remaining code pending | R=3 throughput, CP/Kafka SIGKILL, visible-prefix recovery pass; final combined rerun pending |
| Tools, Cube, Volumes, machines, Preview/SSH | Broker/transport/Volume implementations read; remaining Cube lifecycle code pending | Paid coding, same-Workspace concurrency, actual Snake browser play and machine controls pass; remaining lifecycle faults pending |
| Model routing/configuration and hosted search | Adapter/relay and configuration paths reviewed; remaining code pending | GPT/DeepSeek, reasoning/Fast, Worker handoff and search around Compaction pass on recorded revisions |
| Subagent lifecycle and communication | Core lifecycle/mailbox/native bootstrap paths reviewed; remaining code pending | 11 paid production scenarios pass at 9f62b365, plus family fairness and Worker-loss recovery |
| Frontend pages, controls and rendered latency | Main components and browser interaction fixtures reviewed; remaining paths pending | 93 deployed controls, actual terminal and one Element Timing paint sample pass; final-revision repetition pending |
| Configuration, deployment, migration, CI, monitoring | Partial coverage; current pending findings below | CI passed at 9f62b365; actual custom Web origins under test; separate K3s Authorizer rollout pending |
| Scripts/tests/current docs and unused-code cleanup | Partial hash/range coverage; not a full-read claim | Latest completed local checks are recorded above; clean-state final matrix/cleanup/resume not complete |

## Required live matrix

Track separately: single/multi-round/reload; same-user multi-Session; multi-tenant;
Worker handoff; provider/model/reasoning/Fast handoff; repeated Compaction with
coding/search/children; direct/workflow, fresh/branch, shared/ephemeral Subagents;
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
| STOR-01 | Interrupted Gateway initialization could leave only one of two identity files and permanently reject the Volume | Owner-approved ADR-0172 moves creation to Cube's plugin, publishes one immutable file, and leaves Gateway verification-only. Native 20-way creation, pre/post-publication SIGKILL and deletion grants pass; matching rollout, paid coding/cold reuse and 3×20 live API requests pass at 18e96210 |
| STOR-02 | An initializer that observed an empty directory could later clear another Session's newly written files | Remove destructive seed restore and the metadata-presence setup shortcut. Atomic no-overwrite file publication preserves user bytes/permissions in 20 concurrent initializations and the actual guest seeding code |
| TERM-01 | Releasing one runtime marked every active terminal on the Broker UNKNOWN, including another tenant's | Scope the update to Domain, Broker, Workspace and exact runtime. Real-PG two-tenant regression passes |
| MODEL-02 | Missing/throwing model lookup escaped Session-authority cleanup after successful preparation | Move lookup inside the existing cleanup scope; both regressions require Session close and model release |
| VM-01 | Accepted capsule plaintext could encode above the PG/read-side 128 KiB limit | Derive the input bound from the existing encoded limit; exact-bound round trip, oversized input and authentication rejection pass |
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
| UI-05 | Tree refreshes can finish after selecting another Session; New Chat can reset a pending input submission | Chrome reproduces both. A generation/scope guard covers tree reads; New Chat is disabled only during the pending mutation, not while an accepted Agent Run generates. Browser regression also preserves the newly typed draft |
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
| LIFE-03 | Active Lane cold-history waits used only the shared writer signal | Two regressions reproduce cancellation/close leaving a cold read waiting. Forward task read cancellation to native Lane waits and abort those waits on close; retain final writes and sibling authority. 113 related tests and a paused-projection Parent/Child Host test pass. Deployed coding/child repetition passes; deliberate production projection-stall cancellation remains outside this slice |
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
| DEV-05 | Pause/resume replay treated a recorded request as a completed effect; later actions could overwrite the recorded result | Three HTTP fault regressions reproduce lost request/reply being treated as processed and pause being recorded as a later running state. Persist the Broker acknowledgement instead of an extra latest-state read; reject unconfirmed pause/resume replay without re-executing it. Real Cube old-pause replay after resume passes twice without stopping the preserved process. This does not add Cube-native operation fencing |
| DEV-06 | API/client defaulted machine Sessions to elastic `/workspace`; the client also forced the standard profile | Server/client regressions reproduce both defaults. Machine cwd defaults to `/home/user` and an omitted profile is inherited from the machine; elastic defaults stay unchanged. Explicit choices remain intact; no old-data conversion |
| CLEAN-07 | Domain exported an unused resolved-model parser/schema and unused transition/terminal predicate wrappers | Repository-wide caller checks found only self-tests. Remove unused surfaces; retain actual transition enforcement, Run terminal checks and credential-safe model-profile validation. Domain tests pass |
| CLEAN-08 | Fake-model fixture retained an unreferenced settlement scenario and unused observation fields; some fields had already been discarded by parsing | Remove the unused scenario/metadata instead of presenting misleading compatibility evidence; all 17 HTTP/Pi fixture tests pass. Guest Git ownership comment now describes persistent Volumes, not retired Kubernetes emptyDir storage |
| CLEAN-09 | Guest protocol accepted cancel/shutdown envelopes with no producer or handler; one test/comment still described removed provider checkpoints | Remove unused daemon commands from the one-shot guest input schema; retain current Cube process cancellation. Negative protocol tests now reject retired commands; seed documentation describes initial provisioning only |
| CLEAN-10 | Build/formatter ignore files referenced deleted spikes, guest entrypoint, Supervisor Dockerfile and execution-plane chart | Remove stale exceptions; do not delete untracked local directories. Image source closure and actual image builds remain required |
| DOC-04 | Package READMEs still described Workspace settlements, Run-local leases and Child Workspace modes | Align Control Plane/database/runtime/Web package summaries with physical-Session ownership, direct Kafka projection, persistent Volumes and shared/ephemeral compute; remove unsupported migration-down deployment guidance |
| DIR-01 | Public create-directory accepts 255 characters while Broker/guest reject above 128; Linux also limits component bytes rather than JS characters | Two regressions reproduce long ASCII rejection and oversized Unicode acceptance. API, Broker and guest now share a 255-byte UTF-8 name rule; 21 protocol/provider cases, actual guest CLI and deployed Chrome/Cube repetition pass |
| DIR-02 | Create-directory parser errors bypassed public request validation mapping | Real browser/API test created valid long names but an oversized Chinese name returned 500. Convert this route's input parser error to a 400 only at admission, after authentication; retain downstream protocol failures as server errors. Eight HTTP tests and the deployed browser/API rerun pass |
| TOOL-04 | Guest request JSON is written before the final abort check; on a persistent machine, cancellation before command dispatch does not run the shell cleanup trap | Four regressions cover pre-upload abort, post-upload abort, cleanup transport failure and nonzero cleanup exit. Check cancellation before upload; after confirmed upload, retire only that generated file before any Tool dispatch. Normal execution adds no RPC. Preserve cleanup failure beside cancellation, not a false success. Actual Cube adapter test passes both cancellations, file/side-effect absence and a normal command on the same VM; Volume removed. Process loss/uncertain upload is not claimed solved |
| DIAG-02 | Cube readiness timeout and guest initialization rejection discarded the useful inner failure | Regressions reproduce both lost causes. Retain readiness and structured initialization causes without changing public error codes or enabling creation retries. Wrong initialization input in the first live fixture was rejected and cleaned; the corrected fixture passes |
| TEST-04 | Development-machine acceptance inherited the bootstrap tenant's fake model for its first two coding Turns | Live DB inspection identified both deterministic Turns; excluded from paid coding. Explicit DeepSeek selection and GPT Subagent rerun passes all six real-model Runs, with provider/usage verified in native PG entries |
| TEST-05 | Bash/background test used a 750 ms wall-clock bound against a one-second child sleep | Full real-PG regression under image-build load observed 790 ms and failed this test only. Replace timing inference with a gated child: Tool must settle before the test releases the background process; confirm it then continues. All 14 Tool tests and the fixed-revision full rerun pass |
| DEV-02 | Machine lifecycle descriptor requires an active Domain and non-failed environment profile, including release | Reproduced both rejected releases via the actual Broker HTTP fixture. Separate owner-scoped existing-machine routing from new provisioning descriptor; directory operations and release no longer depend on allocation policy. Cross-user checks remain. Local regression slice passes; deployed Cube repetition pending |
| DEV-03 | Broker concurrent duplicate machine provisioning created two provider runtimes; simultaneous first task bindings chose the same binding ID | Both reproduced. Reuse existing per-Workspace provisioning critical section for machine provisioning/binding creation, not Tool execution. Concurrent parent/child bindings now stay distinct and reuse one runtime |
| DEV-04 | Machine handle entered the ready map before durable state publication; failure destroyed the VM but retained that handle | Reproduced phantom active count. Publish PG state before installing the ready handle; clean failure no longer advertises a destroyed runtime |
| TOOL-01 | A reused persistent-machine binding could return a cached response belonging to an earlier Attempt | Reproduced by delaying old-body retirement while rebinding. Match the reader Attempt as well as binding ID; no PG round trip added |
| CLEAN-01 | Binding-local `materializing` was never written; old terminal-capacity transfer path had no reachable caller | Removed the field/branches/transfer method and its dead-feature test. Physical runtime materialization and concurrent Tool execution remain |
| CLEAN-02 | Native Lane exposed its private reader despite having no caller; one Fork test name incorrectly implied no payload copy anywhere | Removed unused getter; clarified shared query projection versus self-contained Fork log. No persistence semantics changed |
| CLEAN-07 | The Bash test-command classifier had no runtime caller, only its own tests and exports | Remove 188 lines of classifier, its three self-only tests and both exports. Actual Bash execution, outputs and user-invoked tests are unchanged. Current Subagent ADR wording also drops the retired Workspace-copy path and uses the shared family lease |
| CLEAN-03 | UI still polled Run state as a second pre-stream completion fallback | Removed UI poll/action. Live Snake exposed that removing the API client's `getRun` also broke diagnostic/acceptance callers outside the Web package; restored that required read-only method and added an API contract test, without reintroducing UI polling. Full live matrix remains pending |
| TEST-01 | Chrome helper selected a random fixed port, risking another browser under concurrent tests; debugger disconnect could strand pending RPCs | Use Chrome's allocated port from its own private profile, reject pending calls on disconnect, and report cleanup failures. Browser presentation/composer regression passes; parallel browser stress still pending |
| TEST-06 | Chrome helper accepted new RPCs after its disconnect handler had already cleared pending calls | Actual owned target-close test hung until its five-second failure guard. Reject calls on a non-open socket and remove/reject failed sends. Both in-flight and post-disconnect calls now reject; the complete existing Chrome presentation suite also passes |
| DEPLOY-02 | `.dockerignore` re-included entire parent directories, including runtime files and local dependency/build caches | Scratch Docker export with harmless canaries reproduced 11 excluded paths entering the context. Replace broad directory exceptions with build-input patterns and nested local-file exclusions. All 463 COPY inputs remain available, all 14 excluded paths are absent. No evidence of actual credential disclosure; follows [Docker build-context semantics](https://docs.docker.com/build/concepts/context/#dockerignore-files) |
| LIFE-05 | Broker HTTP listener remained open after provider teardown failed | Reproduced with actual local listener; close HTTP in `finally`. Eight RPC/server regressions pass. Also removed unreachable HTTP-side Tool timing branch; executor owns execution timing |
| FILE-01 | Trusted Git preflight discovered a Workspace's `.git/config` | Owned fake-SSH marker reproduced local config execution. Run network preflight outside user directories and disable global Git config; no real credentials or external server involved |
| FILE-02 | Credential reads followed a Workspace symlink outside its volume | Reproduced against an owned fixture; open non-following, nonblocking regular file and bound actual bytes read |
| FILE-03 | Browser path validation could race a parent-directory replacement before open/readdir | Reproduced outside fixture content/names. Validate the opened Linux descriptor and retain it for listing; bound reads if files grow after stat. Volume regression suite passes |
| PERF-02 | Git preflight held the Volume lock/PG lock connection during remote network wait | Reproduced blocked directory access; release after reading the credential, then perform the independent network probe |
| LOCK-01 | Lost copy lock let an old copier remove a newer acknowledged target | Reproduced on owned temporary files. The owner chose shared-Volume compute instead of independent child copies (ADR-0171). Copy APIs/lifecycle are removed; real worktree, parallel/nested compute and home-Volume acceptance pass. No new atomic-copy protocol or Volume Plugin change is introduced |
| MEM-02 | Supervisor retained completed Assignments, publisher contexts and control/epoch bookkeeping | Publisher cleanup removes the original 64-context retention. `32e40930` additionally retires PG-confirmed completed command/control/family caches; real paid batches reach zero retained entries and same-key Steer replay still succeeds from PG. Uncertain controls deliberately remain retained; no TTL discards unresolved outcomes |
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
| LIFE-14 | Worker claim loop awaited cancellation settlement, blocking unrelated ready families with free slots | Controlled delayed-cancellation regression reproduces starvation. Track one in-flight cancellation per target Run, keep admission progressing, and join cancellation settlement during drain. Success/failure and duplicate-target cases pass with queue-wake/reconnect/family-drain regressions (12 cases). PG cancellation authority/retry cadence are unchanged; deployed paid product surface and full regression pass |
| DB-01 / CI-03 | Shared PG pool had no idle-error listener; CI forced database deletion could terminate a still-closing idle client | Independent child-process test reproduces an idle backend termination killing the process. Add the pg Pool error listener with code-only diagnostics; pg evicts the broken client. Real PG test proves a later explicit query reconnects while an interrupted active query still rejects with 57P01, without replay. Authority teardown waits for zero connections and drops normally instead of FORCE. Targeted tests, full CI and paid same-Worker stream fault pass; follows [pg's documented idle-error contract](https://node-postgres.com/apis/pool#events) |
| TEST-03 | Browser acceptance waited for text until timeout after an already-visible failed Run | Actual proxy failure reproduced the misleading 180-second wait. First-text wait now also detects the existing terminal error element and reports it immediately. Real repetition pending |
| ENV-01 | Deployed model relay retained localhost:10808 from an earlier shell, while the current proxy is localhost:12450 | Old port returned ECONNREFUSED before model execution. Owner selected 12450 permanently. Persist the explicit relay proxy in private .env; runtime Compose no longer selects it from generic shell HTTPS_PROXY. Installer/config tests and an opposing-shell-proxy render pass. Paid browser repetition and both model smoke calls pass through the selected proxy; provider credentials unchanged |
| CI-02 | New readiness barriers use ES2024 Promise.withResolvers while the shared TypeScript target remained ES2022 | CI caught the mismatch; earlier local checks had only started, not completed, so the initial pass wording above was corrected. Align the compiler target with supported Node 22.19+; browser keeps its explicit ES2022 library contract. All workspace types and remote CI at 9f62b365 pass |
| TIME-01 | Lease/claim timestamps were captured before potentially blocked SQL updates | Real PG reproduced a lock-delayed renewal reviving an expired lease. ADR-0170 is deployed at 9f62b365: issuance, renewal, validation and retirement use PG decision time; local deadlines are monotonic hints. Nine real-PG boundaries, local checks, CI and paid multi-round/Subagent/Worker-loss acceptance pass. Wider audit remains open; no post-seal corruption or tenant leak was demonstrated |
| PERF-01 | Sixteen concurrent Sessions with sufficient slots still spend substantial time before provider dispatch | Real sample: non-provider TTFT p50/p95 836/1,322 ms versus provider 1,036/2,071 ms; eight of 32 Turns are internal-time dominant. Worker metrics show claim averaging 122 ms. Investigate statement/lock/pool time before changing admission; no claim of full latency acceptance |

## Earlier evidence retained for final regression planning

PERF-01 diagnostic: isolated PG, four pooled connections, 48 Runs per wave and
no model/Kafka/Cube. Claim p50/p95 were 39.6/47.4 ms at concurrency one,
55.1/146.0 ms at four, and 236.2/371.8 ms at sixteen. These include pool waits;
the benchmark also settles fixture Runs and is not a production throughput claim.
The two main captured queries spent 8.0/11.8 ms planning versus 0.3/0.5 ms
executing after fixture settlement. A diagnostic-only join-order limit reduced
planning to 4.1/4.4 ms but changed estimated costs; no production planner setting
or driver was changed. Follow up with eligible-row/mixed-Lane datasets before
choosing an optimization. PostgreSQL documents the [planning search tradeoff](https://www.postgresql.org/docs/current/explicit-joins.html)
and [prepared-plan reuse](https://www.postgresql.org/docs/current/sql-prepare.html).
The current Kysely driver sends unnamed parameterized queries; adding named plans
would also require proving connection-pool/PgBouncer behavior, not only speed.

These are measurements of the named revisions, not claims about the latest
deployment. The finding table above and private hash/range ledger track what
still needs review or repetition.

| Scenario | Recorded evidence |
| --- | --- |
| Real browser, `d923dbb9` Web / `9f62b365` runtime | 93 controls pass. One paid GPT sample: click → text paint 4,606 ms; provider first text 4,330 ms; non-provider 277 ms. Element Timing measured paint, not just DOM insertion |
| Long context, `2bc942b8` runtime | 13 algorithm-coding rounds; two threshold Compactions at 112,473→26,824 and 112,297→24,935 estimated tokens. Marker recall, later coding, Worker replacement, GPT Fast search and DeepSeek search pass. Native assistant totals: 324,994 input / 9,849,088 cache-read / 210,023 output tokens; excludes Compaction and unrecorded retries |
| Subagents, `9f62b365` | 11 paid cases pass after SUB-01 repair: immediate mailbox delivery, supervisor reply, child cancellation, recursion and guest-only workflow. 16,007 input / 184,832 cache-read / 5,030 output tokens. These preceded ADR-0171's compute change |
| Shared-Volume compute, `fd07a098` / `b84ecb30` Broker | [Dedicated acceptance](subagent-compute-20260915.md): 25 parent Turns / 32 children across repetitions, worktree merge, nested compute, machine home Volume and separate same-port previews |
| Product surface, `2bc942b8` | Login/logout, Fork/prune, coding, bounded output, browsing, Terminal concurrency, two Sessions sharing Cube, Steer, cancellation recovery, tenant denial, rebinding and purge pass |
| Snake, `2bc942b8` | Actual Chrome Start/movement/Pause/Reset pass: tick 0→5, remains 5 while paused, resets to 0; isolated Preview returns 200. First durable activity 1,198 ms; settled 52,191 ms |
| Multi-tenant bounded load | Four tenants × two Sessions: 16 real DeepSeek Runs, peak eight active; first-text p50/p95 1,534/2,772 ms. Four tenants × four Sessions under the same eight slots: 32 Runs, p50/p95 2,406/5,109 ms, queue p95 3,552 ms. No marker leaks; foreign-tenant reads rejected |
| Expanded slots | Temporary 16-family/16-model settings: 16 simultaneously active Runs, first-text p50/p95 1,904/3,209 ms, queue 555/1,003 ms. A clock-stepped predecessor is excluded. PERF-01 remains open; settings restored to four/four |
| Kafka-only transport | Three brokers, 1,024 synthetic Sessions, 747,520 records / 10.011 s: 74,668 records/s; ACK p50/p95/p99 12.17/22.39/28.09 ms. Excludes PG/Projector/Tool/model/browser. Temporary topic deleted |
| CP/Projector SIGKILL, `5558ab15` | 41 records produced after CP was confirmed stopped; same Worker boot and one Attempt complete. Visible prefix preserved byte-for-byte; live and canonical text match; total 18.86 s including outage |
| One Kafka broker SIGKILL, `5558ab15` | One Attempt, preserved prefix and matching live/canonical output; total 23.84 s including recovery |
| Session-family loss/fairness | One Worker, two family slots, one model permit: five tasks share two leases; another family progresses while three child Tools wait. Worker SIGKILL seals family before replacement; recovery checks existing files without repeating the old append. 11,799 input / 107,904 cache-read / 5,213 output tokens |
| Authority clock, `9f62b365` | Nine real-PG lock/skew tests and paid family renewal/recovery pass under ADR-0170; local timers remain hints, PG and ordered closure remain authoritative |
| CI | [`642878b9` passed](https://github.com/cookerpapa/pi-cloud/actions/runs/34966690777). Later commits require their own checks |

Do not combine different revisions, fixtures or invalid-clock samples into a
single percentile. API/SSE receipt, first durable activity, first assistant text
and browser paint are distinct metrics. Earlier partial local test counts are
superseded by each completed full invocation, not added together.

## Cleanup and remaining gates

Original baseline: 35 users / 33 tenants and no Sessions, live Workspaces,
machines or active Runs. Preserve those pre-existing identities and formal logs.
Private fixtures and exact cleanup state are in
`.cache/audit-20260915-resources.json`; reviewed paths/hashes/ranges are in
`.cache/audit-20260915-state.json`.

ADR-0171 paid fixtures and the two `642878b9` machine fixtures were removed after
physical Cube/Volume confirmation and FK-enforced deletion rehearsal. The latter
removed exactly 12 Runs, eight views, four native Sessions and two machines/
Workspaces/projects; no active Runs remained. Older campaign identity rows and
the reusable baseline coding Sessions still await final scoped cleanup.

Remaining work:

- finish remaining test, deployment, migration, script and documentation reads;
  application-source reading is covered, with changed-file diffs rechecked;
- finish PERF-01 investigation and repeat cache retirement in the final failure/
  child matrices; TOOL-04/DIAG-02 are deployed and validated;
- complete further regression slices; directory template/browser rollout passed;
- repeat the combined child/Compaction/search/provider/Worker and failure matrices
  on the final revision, including multi-replica control and UI races;
- finish full CI/build/security/fault gates and clean-state product acceptance;
- verify final resources, test topics/logs and temporary PostgreSQL removal;
- keep the resolved stale-template cleanup and Authorizer rollout separate from
  the still-open upstream locator fix and final deployment gates;
- update resume v11 only after all engineering gates pass.

Physical multi-node failover, Cube-native effect fencing and arbitrary shell
exactly-once are not certified by this single-host campaign. Architecture changes
still require owner discussion; ordinary implementation fixes continue locally.
