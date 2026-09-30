# September 30 review: repairs and discussion decisions

Date: 2026-10-01. Starting revision: `7c1f46ec`.
Findings originate in the [September 30 review](repository-review-20260930.md).
This record distinguishes completed changes from work still under validation.

## Scope authorized after the review

- Preserve Worker → Kafka → Projector → Broker → Cube command delivery. The
  owner rejected the proposed Worker-direct dispatch alternative.
- Research Cube-owned execution acceptance and Kafka completion publication
  outside the untrusted guest, with Broker-restart independence as the target.
  Research does not authorize a silent Cube upgrade or a second task scheduler.
- Implement confirmed R30 findings and bounded cleanup without compatibility
  paths. Keep pinned Pi and its public execution/storage semantics.
- Delete conversations and their database history instead of archiving them.
  Reclaim unused elastic compute after its final conversation disappears;
  retain current between-Turn warm reuse and owned-machine release semantics.
- Preserve displayed partial Assistant text and confirmed interruption facts
  in subsequent model context, without replaying partial Tool calls or
  presenting unknown effects as successful execution.

The [Cube execution/result-delivery research](cube-result-delivery-study-20261001.md)
is complete. Its proposed handoff contract is not implemented; D30-01's physical
failure-domain policy stays explicit pending that separate design decision.

## R30-07: direct-Steer runtime composition

The composition test now admits a real Run through the existing test Worker,
then accepts Steer with HTTP 202 and verifies its held source in PostgreSQL.
The actual application reconciler uses the injected remote transport despite
having no local Worker WebSocket connection. The transport reply is deliberately
blocked, proving API acceptance does not wait for delivery. A repeated request
keeps the same source/control identity and does not redeliver an acknowledged
input. No old `kind=steer` fixture or production compatibility branch remains.

Validation: all four `control-plane-runtime.test.ts` tests and the Control Plane
typecheck pass. The complete
release check will be repeated after the remaining review repairs.

## R30-08: installed dependency security

Pi remains 0.84.1. Patched dependencies are pinned: brace-expansion 5.0.12,
undici 6.28.1 / 8.10.2, fast-uri 3.1.8 / 4.1.5, Vitest/@vitest/mocker 4.1.11,
and @nestjs/platform-fastify 12.0.3. Fastify is aligned to the adapter's 5.12.4.
The October 1 audit also exposed the Nest middleware advisory indexed after the
original review; the patch follows its maintainer recommendation. The obsolete
find-my-way replacement is removed because the adapter now supplies 9.9.0.
The guest image's npm brace-expansion preparation uses the same patched version.

References: [Nest advisory](https://github.com/advisories/GHSA-9c5c-9qcx-q35q),
[Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9),
[brace advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr),
[undici 6 patch](https://github.com/nodejs/undici/releases/tag/v6.28.1) and
[undici 8 patch](https://github.com/nodejs/undici/releases/tag/v8.10.2).

The repository security gate passes with no remaining applicable findings.
Raw npm audit still reports the published Pi shrinkwrap's old nested versions;
it does not observe the installed preparation. The gate now compares each
reported affected range with the verified installed version at the exact
replacement node, using pinned node-semver. The static advisory URL allowlist
is removed. A new advisory affecting the installed version, unknown ranges,
another vulnerable installation, or an unprepared dependency stays visible;
an aggregate Pi finding is exempt only after every underlying dependency passes.
This is an installed-tree result, not a claim that raw npm audit exits zero.

Validation: 61 helper tests, 87 Pi/remote-tool contracts, 13 API/composition tests,
11 command-executor tests and 16 Projector handoff tests pass; Web build and image
closure check pass. Workspace typechecks were run; the one Vitest-4 Mock typing
change was corrected and runtime-core rechecked. New subprocess regressions
exercise deep brace nesting and unsolicited WebSocket subprotocols against both
installed undici lines. Future-advisory tests ensure audit exemptions fail closed.

## R30-01: unavailable Tool reply stops subsequent sampling

Rejected native-reply waits now notify the existing infrastructure-failure latch
before surfacing the bounded UNKNOWN Tool error. The thrown error retains its
cause; no command is republished. Explicit cancellation still bypasses the
infrastructure-unavailable classification. This applies the existing ADR-0151
contract consistently instead of introducing a new recovery policy.

All 30 remote-tool adapter tests pass, including actual Pi Agent execution for
timeout, stopped reply consumer, image decode rejection and mismatched reply.
Each case publishes one Tool command and makes only one model request; user
cancellation is covered separately.

## R30-02: opaque JSON properties retain native meaning

Message normalization now defines own properties instead of invoking the
`__proto__` setter. It still removes undefined object values. Nested objects,
arrays and an ordinary own `constructor` key retain their JSON meaning through
the actual native writer and PostgreSQL history. Invalid Tool arguments reach
Pi's normal validation and produce a Tool error without aborting the whole Run.

Validation: 64 CloudAgentRuntime tests and its package typecheck pass, including
two new cold-storage regressions for opaque Tool details and invalid arguments.

## R30-05 and Subagent result SQL

Status maps the Run state before applying its seal guard, so timed_out now waits
alongside all other terminal states. Stable execution states no longer generate
an UPDATE or an otherwise empty explicit transaction. Result lookup joins its
Run, physical Session and native final Entry directly; the unused result Entry
pointer and its write are removed by migration 155. Native history ownership
and the seal boundary remain unchanged.

Validation: 15 Subagent tests and the package typecheck pass. Four full-schema
state fixtures compare every terminal state before/after seal. A repeat completed
result read performs exactly two SELECTs and no writes, compared with the review's
six business statements plus transaction control. Database tests pass (17 tests;
21 real-PostgreSQL opt-ins deferred to final combined verification), including
schema 155, removal of the unused pointer and a second idempotent migration pass.

## R30-06: HTTP response interruption closes both sides

HTTP response forwarding now uses Node's stream pipeline to propagate truncated
upstream responses to the client. A client disconnect cancels the upstream
request; a disconnect during DNS resolution prevents starting a new transfer.
Errors before headers retain the bounded 502 response, while errors after
headers terminate the incomplete response instead of ending it as success.

Validation covers both Content-Length and chunked truncation, client-driven
cancellation, normal forwarding and existing CONNECT/egress policy checks.

## R30-03: bounded delegated task input

[ADR-0204](../adr/0204-bounded-subagent-task-input.md) aligns the public/Worker
prompt character bound and adds a JSON-encoded byte budget specifically for
delegated task descriptions. Native preparation, workflow task validation and
PG admission all reject oversized work before creating a child. NUL and unpaired
surrogates are rejected as unsupported PG text; accepted task text is preserved.

Validation: 109 protocol tests, 82 Runtime/Tool tests and 18 Subagent PG tests
pass, with all three package typechecks. Boundary cases cover ASCII, Chinese,
emoji and heavily escaped SOH text. The real native startup mutation for each
maximum input fits below 900 KiB with an additional 64 KiB envelope reserve;
oversized direct PG requests leave Session/Run/execution row counts unchanged.

## R30-04: bounded inherited context preview

[ADR-0205](../adr/0205-bounded-inherited-context-preview.md) replaces the lifetime
ancestor scan and whole-detail rejection with a bounded read from the frozen
child anchor. Native Compaction summary and retainedTail are respected. Anonymous
retained messages reference their actual Compaction Entry plus messageIndex;
no native Entry identity is invented. UI, reducer and export represent summary
and clipping explicitly, including a child with no started Turns. The inherited
display component is separated from ChatApp; model context and stored history
remain under their original owners.

Validation: two full-schema fixtures with 10,001 historical messages (compacted
and uncompacted) open successfully and leave native row counts unchanged.
Five preview boundary tests, 148 Web tests, 109 protocol tests and 18 Subagent
tests pass, with Control Plane and Web typechecks. The empty retained tail,
summary-only rendering, Unicode-safe clipping and clearing old preview metadata
on a replacement snapshot are covered.

## D30-03: incomplete visible text and confirmed failure context

[ADR-0206](../adr/0206-interrupted-output-context.md) projects ordinary text from
stored errored/aborted Assistant messages as explicitly incomplete context.
Original native entries remain exact. This has no second-prefix-write crash gap,
and thinking, private diagnostics and partial Tool arguments are not replayed.
Native Compaction and retained-tail restoration apply the same projection.

Known failure reasons flow through the trusted Runner's existing error state and
cancellation signal. Cold Session opening also materializes a missing predecessor
interruption, including a failure without visible text. Existing native recovery
IDs, generated metadata and atomic prefix clearing provide deduplication; no
receipt table or second state authority is added. An already described unfinished
operation is closed without adding another generic interruption fact.

Validation: 97 Runtime/PiRunner tests, the extended native-Host Parent/Child and
replacement integration, reason-classification tests and Runner/PG/API typechecks
pass. Actual pinned Pi provider conversion preserves the partial text exactly
once across repeated restore. Native Compaction receives it both as an ordinary
failed entry and inside an earlier retained tail. A no-prefix Tool-UNKNOWN
failure is described after Host replacement without reflecting its diagnostic.

## D30-02: permanent history deletion and unused elastic compute

ADR-0207 and migration 156 replace archive/unarchive with an atomic, tenant-scoped
subtree deletion. The API commits before 204; repeating the absent URI needs no
stored deletion receipt. Owned control/native history and attachment/upload
references disappear together. Independent native copies, shared image references,
Workspace bytes and user-owned development machines retain their separate lifetimes.
Pruning's surviving marker is named `pruned_at`; its public count is
`prunedSessionCount`, and hidden logical views do not consume usable-Session quota.
The obsolete archive service, operation table and public operation resource are removed.

The last retained conversation disappearing wakes Broker cleanup with a bounded PG
notification. The existing runtime rows remain the authority, with periodic fallback.
The scan respects shared compute scopes and ordinary between-Turn warm reuse, runs
without overlapping passes and joins on shutdown. Failed deletion remains accounted
for and retryable; the Cube provider confirms absence before reporting success.
Bootstrap IDs remain in cleanup records without retaining Session/Run/Turn history.

Validation: 24 Control Plane tests (including 12 on dedicated PostgreSQL), 86 Broker
cleanup/provider/lifecycle tests, 23 Web API tests and 11 schema/cutover tests pass.
Control Plane, Broker, Web and database typechecks pass. Regressions cover child
admission/Fork races, current and expired-but-unreleased writers, unsealed native
history, tenant isolation, independent Forks/images, pending uploads, retained Kafka
append replay, shared VM retention and failed cleanup accounting. The historical
migration fixtures now seed historical contracts directly instead of calling today's
Session admission against an old schema. Provider absence confirmation was rechecked
with 28 provider tests after correcting the fixture's seed type. Documentation check
passes. Production acceptance scripts now expect deletion to reclaim unused compute;
those live scripts and the destructive migration have not been run against production.

## Bounded cleanup: Steer receipt and production repository surface

A newly accepted direct Steer returns its receipt identity from the successful
transaction. The post-commit SELECT is removed from that path. Idempotent replay
still reads the existing control receipt and preserves the same fingerprint and
source/target identities; uncertain transaction outcomes do not reuse a captured
uncommitted ID. A query-count assertion verifies zero receipt SELECTs for creation
and one on replay. All 29 queue/composition tests pass on dedicated PostgreSQL and
the Control Plane typecheck passes.

The in-memory Workspace ownership implementation is moved to test helpers, with
its production export removed. The repository port and PostgreSQL implementation
remain. All 73 Broker/provider tests and the Broker typecheck pass.

## Session lifecycle and obsolete probes

ADR-0208/migration 157 align the public/domain/PG Session states with atomic Run
admission: cold/idle → running. Retired starting/evicting states and the never-persisted
recovering intermediate are removed. Failed → idle still requires the existing
Agent-exit/seal/no-live-work SQL proof. Worker and VM lifecycles stay independent.
Unsupported stored states block migration atomically rather than being silently reset.

Validation: 113 protocol and 16 domain tests, two schema/cutover tests, all 43 atomic
admission cases (including the updated product-reference deletion guard), and three
real-PG recovery orderings pass. Every workspace typecheck passes in the combined
check. The combined full-test pass is recorded below when complete. Both browser
presentation and queue-editing checks pass; the fault matrix passes 104/104 cases.

Four one-off probes that asserted the old bugs are removed from current scripts.
The original review retains its baseline evidence and identifies commit `7c1f46ec`
for historical reproduction; the maintained tests assert the corrected semantics.

## Final security follow-up: gRPC transitive dependency

The final audit additionally returned GHSA-m9gg-hp2v-232j (high) and
GHSA-f596-whhp-79r4 (low) for OpenTelemetry's indirect grpc-js 1.14.4. These
September 17 advisories were newly returned by this audit pass, not newly
published on October 1. Root overrides and the lockfile now pin 1.14.5; no other
lockfile dependency was upgraded in this last patch. No new audit exemption is used.

The maintainer documents the affected server certificate-authentication setting
and unintended handler-error disclosure in the
[authentication advisory](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j),
[error-details advisory](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4)
and [1.14.5 release](https://github.com/grpc/grpc-node/releases/tag/%40grpc%2Fgrpc-js%401.14.5).
This is a vulnerable dependency finding, not proof that PiCloud exposes the
corresponding gRPC server configuration. The current dependency arrives through
telemetry exporters.

A local public-API transport regression demonstrates handler-error disclosure on
installed 1.14.4 and absence of that disclosure on 1.14.5. It now runs against the
installed telemetry dependency in the helper suite. After installation, all 62
helper tests, nine observability tests and that package's typecheck pass. Build,
image closure, dependency hardening and the installed-tree security gate pass;
no remaining applicable vulnerabilities are reported. Raw npm audit still sees
three old Pi shrinkwrap metadata findings, handled only through the exact
installed-version/range verification described under R30-08.
