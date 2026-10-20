# Model response and Agent lifetime repair

Status: source implementation and required source checks complete, 2026-10-20.
Serving runtime remains `native-recovery-8c00826a`, schema 191. This record does
not yet claim the schema-192 matched release or long-work live acceptance.

Decision: [ADR-0263](../adr/0263-model-response-and-work-lifetimes.md).
Scope: owner-approved [repair plan](model-request-response-repair-plan-20261019.md),
including removal of the overall Run duration limit.

## Source changes

- Delete the Runner timer, duration policy column and private duration fields.
  Model grants follow current Run/Conversation ownership and Worker boot rather
  than a separate TTL. Revocation interrupts requests before unrelated cleanup.
- Worker shutdown allows 30 seconds of natural drain, then closes admission to
  late claims and uses existing ownership retirement/same-Run recovery. Retirement
  is bounded independently at 660 seconds; process cleanup has its own final
  bound. Unconfirmed settlement never becomes an owner-exit proof.
- Pi's public parsed provider events and normalized model events now meet in one
  request-local Models adapter. The old Gateway SSE interpreter, phase maps and
  hosted transcript/activity subscription plumbing are removed.
- Early text phases follow stable provider/native slot mappings. Completed hosted
  items use empty native text slots with PiCloud metadata; no visible text or local
  Tool call is fabricated. The exact-model payload hook replaces their owned
  placeholders with provider-native items in their original positions. Other-model
  context excludes those carriers. Incomplete local calls remain private.
- Gateway errors retain native retry classification. The Models port preserves
  known HTTP/provider transient meaning while respecting Pi's terminal quota and
  billing exclusions. Durable remains the only sampling retry owner.
- Semantic model execution and HTTP transport have separate metrics. Native
  terminal success before EOF remains successful; transport disconnect is still
  recorded. Parsed-event timing is correlated with HTTP timing using the existing
  sampling identity and same-process monotonic clocks.

Native commit/abort semantics are unchanged. Completed hosted metadata survives
an acknowledged partial and ordered handoff; events not yet committed have no
stronger durability promise. Pi 1.0 retains aborted/error Assistant entries as
history but excludes them from later model context; this repair does not override
that rule or make late output replace native abort.

## Evidence recorded so far

Focused tests cover both real native provider adapters over loopback HTTP,
native transient retry and terminal billing/configuration errors, phase mapping,
hosted-only Stop/cold reopen, exact payload replay, and semantic success before EOF.
Real-PG cases verify no in-flight hosted bodies in retained PG history, canonical
aborted search reconstruction, and ordered checkpoint/reopening with the original
Submission. Their publisher projects synchronously in the fixture; they do not
claim real Kafka failover or a live provider.

A controlled one-hour wait in the Runner's model admission path completes without
the old total timer. A model grant remains valid across a controlled 24-hour wall
clock change and is rejected immediately after owner revocation. Separate tests
cover bounded retirement, unavailable settlement and a late claim after retirement.
These do not replace the required real Run crossing both old time thresholds.

Initial fixture corrections included a removed-export import, a schema-count
expectation, and the PG fixture's missing replay position, native TEXT Session ID
cast and Storage close Context argument. Private failures are retained; they are
not presented as production defects or silently counted as passing checks.

The first full CI attempt also exposed obsolete startup-test configuration:
its mocked config omitted the two new retirement fields, causing a NaN deadline
and three uncaught timer errors despite passing assertions. The fixture now uses
the real bounds and controls failure-path timers; it also verifies the hard exit
remains armed after cleanup errors. All 85 Supervisor tests and its typecheck pass
after correction. The other 1,891 workspace tests passed in the original run;
11 environment-gated cases were skipped. The remaining CI stages are run separately,
not reported as an uninterrupted green `npm run ci` invocation.

The initial deployment inventory has no active Runs/writers/VMs; original account,
model and credential fingerprints are saved. Cube-node KVM preflight passes.
Repository formatting/documentation, install/runtime policy, native Cube contracts,
Helm/observability/image closure, build and typechecks pass. All 1,976 workspace
assertions pass after the fixture correction above; 80 acceptance-helper tests,
nine isolated real RF3/PG transport tests and all 361 fault cases pass. The dependency
audit reports no remaining vulnerabilities. The quota-classification follow-up
also passed 34 targeted tests; final whole-workspace/fault runs include it.
Artifact checks, matched deployment and owned live acceptance remain. Evidence is under
`deploy/production/runtime/release-evidence/model-runtime-20261020/`.
