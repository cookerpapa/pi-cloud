# Native remote tools — implementation worklog

Status: in progress. No deployment or acceptance claimed.

## Reviewed

- Current architecture, streaming/crash and Cube contracts.
- Pi 0.84.1 Tool callbacks and edit implementation; newer ExecutionEnv capture.
- Worker remote filesystem adaptation, guest helper, Broker result cache/router.
- Unified Projector and Kafka replay/commit behavior.

## Plan

1. Whole native tools in guest, native update/end envelopes and source capture.
2. Confirmed commit-before-dispatch with monotonic replay boundary.
3. Worker-boot Kafka reply transport and removal of completed-result GET/cache.
4. Regression/fault tests, deployment and paid GPT-5.6 Luna/Cube acceptance.
5. Remove obsolete paths, update architecture, cleanup and commit/push.

## Constraints

- User requested Pi-native reply payloads, not new update/result/error concepts.
- No DeepSeek requests; no subagents for implementation.
- Preserve unrelated user data, existing dirty edits, and all safety boundaries.
- A Kafka reply is not a canonical Tool Result or permission to reopen a seal.
- Faults before/after dispatch may be UNKNOWN; never rerun an uncertain command.

## Evidence

- Initial worktree was clean.
- Source Tool, Worker adapter, native reply mailbox and simulated commit/replay
  gates: 37 tests passed. Broker routing/authority/WebSocket checks: 31 passed.
- Real RF3 Kafka reply probe: 30 operations / 60 native events / two Worker
  boot mailboxes; two-event publish-to-receive p50 17.03ms, p95 30.10ms.
- Real Kafka dispatch replay probe: projected positions 0..3; executed only 1
  and new position 3, not replayed position 1. Two initial fresh-start probes
  timed out (cleanup masked their cause); further cold-start repeats required.
- Before-cutover GPT-5.6 Luna baseline: two completed coding Runs, 43.247s and
  37.570s, nine model requests, write/read/edit/bash. Test Session and Workspace
  deleted through API; remaining project/DB cleanup still to verify.
- Fixed guest bundle CJS dependency loading using esbuild's Node createRequire
  banner; standalone bundle now starts and validates its input normally.
- Main services have NOT been redeployed. No DeepSeek requests were made.
- Full initial root suite: 1,054 passed / 6 failed / 107 opt-in skipped. Failed
  old fixtures were updated for migration 148 and the removed GET/cache contract;
  selected runner/authority regression reruns passed (full final rerun pending).
- All-workspace typecheck, web build, docs/image-closure/Helm/time-budget/
  observability/installer checks passed at the intermediate revision.
- Cold Kafka trials additionally exposed background consume errors swallowed by
  Confluent's KafkaJS compatibility layer (actual error: Unknown topic/partition).
  Metadata warming/refresh experiments did not fully fix it and were removed.
  Pinned official 1.10.1 (resolved-offset/seek fixes) and bridged public consumer
  logger errors into the existing restart/error boundary; validation is running.
  Upstream references: confluent-kafka-javascript issues #476/#497 and v1.10.1.
- Final first full unit pass: 166 files / 1,065 tests passed; 107 opt-in tests
  skipped. Real PostgreSQL opt-in suite: 22 files / 158 tests passed. All 38
  deterministic fault cases passed, including commit-before-dispatch and late replies.
- Kafka cold assignment/replay: two non-debug batches of 20 trials passed.
  After 310 seconds idle, a reply reached its Worker in 15.365ms.
- Added split-UTF8 NDJSON ordering and retired-boot Topic/group cleanup tests;
  cleanup is idempotent under concurrent Projectors and retains live boots.

## Remaining

- Finish reply-topic lifecycle/retired-Worker cleanup, old metric/docs cleanup.
- Fix remaining tests for removed HTTP retrieval and operation ledger; run full
  type/build/regression/fault checks and guest streaming/cancellation checks.
- Deploy matching guest image/template and services with no active Runs.
- Paid Luna multi-round/subagent/preview/concurrency acceptance and timing.
- Verify cleanup, aggregate evidence, commit and push. Do not claim completion.
