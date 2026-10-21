# Runtime capabilities and delegation delivery

The owner approved all slices in the
[consolidated plan](subagent-wait-review-20261021.md). Runtime implementation
`5d39828d` is deployed as `runtime-capabilities-5d39828d`, schema 197, under
ADR-0268/0269, following the initial `2f7d1b3c` release. The reviewed Ultra
catalog is installed. Profile/browser, native recovery, catalog-only and complete
Cube checks pass as described below. Original account/configuration/credential
hashes match the pre-release baseline, and all owned live resources are cleaned.

## Guest network policy slice

Source sends credential-free network-policy snapshots on Worker registration,
change and reconnect using the existing management WebSocket. The existing
configuration reader also notices changes from another process. Worker retains
the latest revision; Pi's native `cloud-network` section renders policy on model
preparation. No per-model/Tool SQL or copied proxy credentials are introduced.

Control Plane and Supervisor Host type checks pass. Native conversation,
WebSocket and protocol/settings tests pass 34 checks, including a
policy change between requests of the same native submission and unchanged
section deduplication. The settings-observer repeat also passes, covering
cross-process refresh and suppression of unchanged policy notifications.

The serving global egress setting was disabled and had no configured proxy at
revision 6. After successful npm and PyPI HTTPS requests through the current host
proxy, the maintained PlatformRuntimeSettingsService enabled that proxy at
revision 7. The existing Cube egress gateway then returned HTTP 200 for both
registries. This proves the proxy route, not yet a fresh guest execution.
The first operator identity lookup found no password credential and made no
change; the successful mutation used the configured platform operator's existing
API identity. Accounts and credentials were not changed.

Private configuration evidence is in
`deploy/production/runtime/review-evidence/runtime-capabilities-20261021/`.
Acceptance preserves the deliberately enabled setting, rather than restoring
the old disabled state. Real guest npm/PyPI GETs both returned HTTP 200 after the
matched release; the effective native network-policy section is enabled.

## Ultra profile slice

Source adds Ultra to the existing effort picker/catalog and retains the selected
value in Session/Run records and the existing native cloud-run document. One
profile resolver maps Ultra to native/provider Max plus proactive instructions;
other efforts use explicit-request-only instructions while retaining tools.
Pi renders a named delegation section. The previous unconditional encouragement
is removed. Migration 197 expands current thinking-profile constraints after
writer draining; no queue, lease, task or compatibility layer is added.

Native tests observe the same offered subagent tool with different Max/Ultra
instructions and provider Max. Protocol/domain/native lifecycle checks pass
29 tests; a real PostgreSQL test verifies accepted Ultra survives catalog changes
and dispatch with its original Run snapshot. Web, Worker and Runner type checks
and six Web settings/translation tests pass. Initial failures were duplicate
Ultra values in fixtures that already read the updated catalog, plus an obsolete
domain-test runtime field; they are corrected rather than adding runtime
compatibility behavior.

## Parent child-progress slice

Source derives parent identity from the Worker's existing native family and sends
it with child activity. Projector validates both admitted scopes, forwards a
disposable `run.child_activity` to the parent SSE and observes canonical child
termination. Per-child revision keys prevent siblings from overwriting each other;
writer replacement clears old phases. Existing child summary reads now include
the parent Tool and child Turn IDs. The browser coalesces relationship refresh on
discovery, lifecycle change and reconnect; phase updates add no SQL.

Parent cards show task/phase/navigation with invocation details closed. Tool groups
also start collapsed and no longer expand themselves on progress/failure. Native
final state wins over late phase data; unknown freshness is not a task failure.
Only cards with children subscribe to child observations. No child text is copied
into the parent or native context.

The existing Web/observation/recovery transport suite passes 55 tests; 19 real-PG
child/tree checks pass. The focused 14-test transport/child UI repeat covers
siblings, phase freshness, terminal priority and writer handoff. Control Plane,
Worker, Web and runtime-core type checks pass.

## Ordinary control Tool catalog slice

Source implements ADR-0269: execution modules own declarative definitions and
handlers; the management WebSocket delivers full immutable catalog snapshots.
Workers retain the last valid snapshot, wait for an initial catalog before
ordinary Run admission and install generic callbacks into Pi's Registry. Native
subtractive selection and explicit infrastructure extensions preserve existing
file/role grants while admitting new ordinary names on the next prepared request.
Pi itself records changed tool declarations. There is no cache-preserving loading
protocol, extra history table or per-request catalog SQL.

Preview's definition moved out of Worker-owned infrastructure metadata. Generic
dispatch parsing no longer hardcodes ordinary names; current handler admission
and schema checks produce explicit unavailable/invalid-argument results. Pending
handlers keep their captured implementation. Remote hooks are replaced with the
same native phase snapshot as their definitions, preserving intent-before-effect
even when withdrawal races preparation. Native child/workflow adapters remain
fixed; arbitrary guest tools and unsafe shell work are outside this catalog.

A native submission test adds a previously unknown name while waiting for a Tool,
uses it on the next request, withdraws it inside its accepted handler, retains its
successful result and rejects a later call. Unchanged catalogs produce no extra
system history. WebSocket tests cover registration/change/reconnect; Worker
lifecycle, native child management and existing control reconciliation tests pass.
The initial new fixture used a reply sequence across operations instead of the
existing per-operation value; correcting the fixture preserves the production
reply contract. Type checks and the Helm empty-list rendering contract pass.
Ordinary reply admission also preserves the existing 50 KiB/2,000-line control
result budget; oversized completed output produces a bounded error without a
second handler execution. Its focused regression passes.

The maintained live browser driver has an explicit runtime-capability mode.
The matched application is deployed. Separate live scopes retain their own
results; a failed combined invocation is never relabeled as an overall pass.

## Full-check findings and rollout boundary

The first full CI run completed build/type checks and all workspace suites, but
reported dated fixture expectations: hidden DeepSeek Pro selections, a missing
frozen vision snapshot, schema-195 assertions, historical admission using current
code and missing child-summary identities. These are corrected in test data.
The pre-184 migration fixture now inserts its historical Run directly instead of
adding compatibility to production admission. The eight affected files pass
70 checks after correction. One existing locked-relay test hit its 30-second
limit in the full run and passed unchanged in both isolated and file repeats;
no runtime timeout or assertion was relaxed.

The acceptance-helper run initially used the operator log's private umask, which
made a temporary Git fixture's file modes differ from checkout modes. Running
the suite with the normal source-checkout umask passes all 94 checks. Kafka,
fault and dependency gates subsequently pass: 9 transport checks, all 361
deterministic fault cases and the high-severity dependency audit with no
remaining vulnerabilities. The fault report retains its tested runtime revision
and dirty-fixture flag; it is not a live chaos experiment. The original
`npm run ci` exit was not a pass.

Final existing-account review reproduced an admission bug: a credential profile
created before Ultra still carried the old effort list and rejected the new
catalog selection. Real-provider admission now takes capabilities/defaults from
the one current catalog, retaining PG identity/enablement and the accepted Run
snapshot. A regression first fails on the old behavior, then passes for an old
profile, Ultra selection, subsequent catalog withdrawal and frozen dispatch.
The model/account repeat passes 16 tests; input/queue checks pass 20 tests,
including the unchanged eight ordinary intake SQL statements. Control Plane
type checking also passes. The runtime-image candidate is regenerated for this
final admission correction.

All eleven final candidate images for `2f7d1b3c` passed scanning and matched
preflight. The owner explicitly authorized releasing the existing development
machine and deleting its entire Workspace. The maintained lifecycle confirmed
machine release, Workspace physical purge and an all-node inventory with zero
VMs before matched replacement. No active Run, lease, terminal or Tool binding
remained. Account, credential and model-profile row hashes plus host/cluster
secret hashes match their pre-release baseline.

## Live findings and operator corrections

Browser Stop, queued-image return/resend and direct vision pass, as do native
Read aliases and UTF-8-safe 50 KiB truncation with canonical diagnostics. The
first capability check incorrectly expected unchanged native sections to be
repeated in the current Run. The acceptance reader now reconstructs the owned
Conversation's effective state across Runs using Pi's transcript utilities,
excluding child configuration. Its regression covers retained sections, child
isolation and section/Tool withdrawal. Production history policy is unchanged.

The matched operator correctly retained the installed catalog override, which
did not yet offer Ultra. Publish the reviewed catalog separately after the
schema/app upgrade; only reasoning selections change, with defaults, routes,
budgets and credentials preserved. This prerequisite is now explicit in the
matched-release procedure. Native-input acceptance also updates its obsolete
schema-195 assertion to schema 197.

Catalog probes exposed two fixture assumptions. DeepSeek thinking mode rejects
forced function selection and returns the reviewed `deepseek-flash` response ID
for the `deepseek-v4-flash` request ID. The bounded probe now uses automatic
selection for this provider and accepts that explicit identity pair while still
rejecting substitution. Luna twice answered that its Tool was unavailable when
the probe disabled tools on the result-reading request. Keeping the same tool
definition and automatic selection, as in ordinary native work, passes its
targeted repeat. The probe still requires the exact Tool call and result marker
and rejects a repeated invocation. Regression checks pass. A clean operator
checkout also needed its local Helm chart dependency built before rendering;
the failed preparation did not publish configuration. Catalog
`catalog-3c696ce8510a-mvi4uj0y` is now published: all four affected model routes
pass text/function probes and 80 scoped checks pass.

All five native-input/live-progress cases pass: consumption, Stop return,
Worker recovery, streaming Stop and simultaneous Worker/Control Plane crash.
Recovery retains the logical Run, edited inputs and observed partial text;
streaming bodies remain out of PG. Fixture physical cleanup is confirmed.

The first live Ultra child completes and replies, but browser acceptance exposes
a real presentation-data omission: the default human-focused tree returns no
child summaries. The focused reader now includes relationship summaries while
excluding child native bindings/entries from its history reads. A real-PG
regression covers a child whose native Conversation is not yet attached; the
tree/history and child UI repeat passes 17 checks. The test's initial attempt to
clear the required physical Session binding was invalid; it now models only the
nullable native Conversation binding. The correction is deployed in `5d39828d`;
actual browser progress and closed details pass. The navigation fixture initially
expected the address bar to change, whereas the existing UI navigates internally.
It now verifies the selected child's actual Turn and read-only view; that repeat
passes, as do parent/child Ultra instructions, native child Max and explicit
delegation at Max.

## Compatible replacement and final scope evidence

The first rolling catalog replacements exposed a separate runtime handoff gap.
Both Workers received the new catalog, and Bash remained offered, but a new Run's
pre-execution reservation followed the old Sandbox owner's Pod address. Captured
PG evidence shows that old owner's short lease still valid while only the new Pod
remained. Startup recovery had therefore not acquired the retained VM. No Bash
execution occurred for the blocked Tool. One later repetition also encountered a
transient API 503; another combined invocation stopped earlier on unconfirmed
external package-registry access. Their failed results and cleanup remain in
private evidence.

Use the owner's existing single-controller replacement preference: stop the old
Pod, wait for its PG sandbox-owner lease to close/expire, then start the new
configuration and let existing startup adoption finish before readiness. The
fixture reuses the guarded outage/watchdog receipt; it never clears ownership or
reissues shell work. The isolated catalog scope passes all four configuration
changes (`[]`, `[preview]`, `[]`, original `null`). Adding/removing preview within
active native work preserves both Worker identities and the original Run lease/
fence. The newly offered preview executes successfully. DeepSeek Flash Ultra
also completes its ordinary Bash call; hosted search is not tested. Original tool
selection and all fixture resources are restored.

General overlapping-controller admission remains an explicit backlog item;
the planned replacement result does not establish gap-free rolling replacement.
The scope switch makes catalog follow-ups independent of already-verified
browser/child/network fixtures. It is labeled in every report, and never implies
those skipped checks passed in that invocation.

| Evidence | Result |
| --- | --- |
| Final `5d39828d` matched images/preflight | 11 images pass; deployed |
| Focused child tree/history/UI regression | 17 checks and Control Plane type check pass |
| Browser Stop, image return/resend and Read | Pass in retained combined runs |
| Guest npm/PyPI, Max/Ultra, child progress/navigation | Pass in retained combined runs before the separate rolling-catalog failure |
| Native input/Stop/Worker and dual-process recovery | 5 cases pass on initial `2f7d1b3c`; later runtime delta is the focused-tree read fix |
| Final catalog-only / Luna / Flash | Accepted; original Worker/Run/lease identities and configuration restored |
| Acceptance state reader and guarded outage helpers | 8 checks pass |
| Complete Cube production gate on `5d39828d` | Accepted: real KVM, preview, cross-Run process/VM reuse, fresh-VM recovery of 1,025 Workspace files, retired-VM admission rejection and physical cleanup |
| Final preservation | All original 32 tenants/users, 35 credential bindings/model profiles, passwords/API credentials and policies unchanged; all 27 host-secret and 9 cluster-secret hashes match |

The full Cube driver leaves account/project fixture metadata for operator cleanup.
After API deletion confirmed all three Workspace storage purges and no sessions
remained, the maintained owned-tenant cleanup removed only its new fixture tenant.
The identified foreign isolation project was also removed without touching its
existing tenant/account. Final inventory has zero active Runs, writers, Tool
bindings, VMs, development machines or terminals; native inventory scans the one
current node and confirms zero VMs. Serving application/Cube workloads are Ready,
and the approved public-egress setting remains enabled at revision 7.

Private JSON, configuration receipts and the child-progress screenshot are under
`deploy/production/runtime/review-evidence/runtime-capabilities-20261021/`.
No session transcripts or credentials are committed.
