# Native remote Tool acceptance

Runtime revision: `e54b46d1`. Single WSL host, three RF3 Kafka brokers, PostgreSQL,
one Pi Worker and real Cube KVM. Follow-up changes are documentation, test script
and a transport comment; no second runtime implementation was introduced.

## Contract

Whole read/write/edit/bash Tools execute in a one-shot Cube Node helper. Native
Pi edit/write algorithms and truncation primitives run at source. Text reads
retain bounded ranged access; shell capture retains the existing cloud process
lifecycle and credential redaction. This is a PiCloud ExecutionEnv adapter, not
an assertion that all upstream/local filesystem behavior is identical.

Pi-native `tool_execution_update` / `tool_execution_end` payloads return through
a Worker-boot Kafka topic. The receiving adapter calls `onUpdate` or completes
`execute`; the trusted Pi Harness owns after-tool hooks and the canonical result.
Partial Tool output is not inserted into context or exposed as public stdout
streaming. One whole invocation has one UUID operation ID; native toolCallId stays
unchanged. No completed-result GET/cache or PostgreSQL operation ledger remains.

Projector commits consumption progress before Tool dispatch. A crash in that gap
may skip execution: UNKNOWN is intentional, not at-least-once shell replay.
Projection replay does not rewind this effect boundary.

## Verification

- Full local suite: **1,074 passed**, 107 opt-in skipped; all-workspace typecheck,
  format, documentation, image closure, Helm, installer, runtime-policy and build
  checks passed. Real PostgreSQL opt-in suite: **158 passed / 22 files**.
- **38/38 deterministic fault cases**, including confirmed commit-before-effect,
  replay/rebalance, sealed late replies and Worker reply isolation.
- Native conformance checks cover edit BOM/CRLF and ambiguity, output/cancellation,
  UTF-8 frame splits, duplicate/late results, and actual Pi Agent callback/hook
  order. A completed callback produces one canonical result, not remote duplicate
  lifecycle events. Topic/group reaping retains live boots and tolerates concurrent
  deletion, but does not hide network failures.
- Real RF3 replies: 30 operations / 60 native events across two boot mailboxes;
  two-event publish-to-receive p50 **17.03ms**, p95 **30.10ms**. Forty repeated cold
  starts/replays passed; after 310s idle, a reply arrived in **15.365ms**.
- Real Luna coding: insertion sort and binary search, multi-round read/write/edit/
  bash, plus 1.5MB output. Before: large output failed. After: execution succeeds,
  bounded output retains `LARGE_OUTPUT_DONE`; no full-output artifact is promised.
- [13-round Subagent suite](subagent-production-acceptance-latest.json): fresh and
  inherited context, concurrent/nested tasks, shared and temporary compute, Git
  worktree/local merge, messaging, supervisor reply, cancellation and tree reload.
- Worker SIGKILL after `BEFORE` was written and before a sleeping command wrote
  `AFTER`: old Run failed/sealed; the process finished, but its late result did
  not modify closed history. A new Run on the replacement Worker read both lines,
  each once. This proves the tested semantic recovery/no-replay case, not physical
  side-effect rollback or exactly-once execution.
- [Control Plane SIGKILL](control-plane-restart-acceptance-latest.json): same Run
  and Worker completed; 41 records accumulated while Projector was down. Reconnected
  text exactly matched canonical history and preserved the visible prefix.
- [Snake browser acceptance](snake-preview-acceptance-latest.json): 14 Tool calls
  and preparation indicators, authenticated host preview HTTP 200, actual start,
  movement, pause and reset. No system-prompt or model-output translation changes.

All paid calls used **GPT-5.6 Luna**, never DeepSeek. Native usage across test
executions (including baseline, the earlier quota-interrupted suite and the final
repeatable probe) recorded **384,802 input, 945,664 cache-read and 21,020 output**
tokens. These are provider-reported counters, not a billing estimate.
The September 22 Subagent attempt hit provider quota at round ten; it was not
counted as a pass. September 24's complete repeat passed.

## Timing interpretation

Matched prompt probes, one sample per Tool (not a statistically controlled speedup):

| Boundary | Before | After |
| --- | ---: | ---: |
| first write, including cold Cube | 4,228ms | 4,347ms |
| warm write | 470ms | 309ms |
| read | 264ms | 328ms |
| edit | 652ms | 449ms |
| warm test Bash | 394ms | 283ms |

Model generation varies substantially: first round 43.247→93.102s, with provider
transport 36.869→86.406s. Second round 37.570→38.134s, provider 35.373→36.677s.
The remainder includes Cube startup/execution, scheduling, publication, settlement
and polling error; it must not be labelled pure Kafka latency. Structural gains
are bounded source output, fewer edit RPCs and removal of result storage/retrieval.
These tests do not establish multi-host capacity or an overall latency speedup.

The [maintained two-round probe](native-tools-acceptance-latest.json) was then run
again successfully: warm read/edit/write/test Bash boundaries were 224–371ms;
the large-output Bash completed in 452ms with a 497-byte canonical result.

## Findings and operational limits

- Cold Kafka probes exposed background errors that the pinned client's `run()`
  did not propagate. Use the official 1.10.1 client and its public error logger to
  enter the existing recovery lifecycle. Metadata-warming workarounds were removed.
- Source bundling required Node `createRequire` for a Pi dependency's CJS import.
- A stale Compose bootstrap container broke a dependency restart despite a
  successful one-off migration. Recreated it from the matching image; deployment
  instructions now explicitly cover that case.
- After WSL reboot, the old 4GB Cube template twice failed during Guest Agent
  `SetGuestDateTime` with a ttrpc timeout, before Tool code ran. Rebuilding the
  same specification/image restored creation and Snake passed. The underlying
  snapshot/vsock defect is **not yet established or fixed**. No auto-retry or
  template fallback was added. Two failed test instances were deleted through
  Cube API; their leftover Shim processes required exact-ID host cleanup.
- The replaced template initially could not be deleted because its replica
  still pointed to `10.42.0.124`, whereas the same node now uses `10.42.0.157`.
  In the owner's September 24 cleanup follow-up, zero live references were
  verified and only that retired replica's locator was corrected. Cube's official
  delete then removed `tpl-afeed7df117d475992523fa9`, its job/replica metadata,
  memory snapshot and private writable layer; the empty parent directory was
  removed separately. The current `tpl-4ffa8c7ef26d4b79a300c141` and their shared
  rootfs artifact remain intact and READY. This was scoped operational repair,
  not an automatic node-endpoint reconciliation fix. Unrelated older templates
  were not deleted.
- Security audit passed its high-severity gate; two existing moderate dev-only
  Vitest findings remain. No package-major upgrade was bundled into this task.

## Reproduction and cleanup

Use the opt-in commands in [Evaluation](../EVALUATION.md); native Tool acceptance,
Subagent and restart scripts select `openai-codex` / `gpt-5.6-luna` explicitly.
Never treat a skipped live gate or a quota failure as success.

Removed 41 test conversation views, 66 Runs, nine physical Pi histories, 11
Projects/Workspaces, three machine records and six test tenants/accounts after
API retirement and confirmed Volume purge. Counts returned to the pre-test state:
33 tenants, 35 users, one Session, seven Runs, one Workspace and one released
machine record. Original users and their conversation remain.
The active Worker's reply topic and formal service logs are retained; retired-boot
reply topics were verified reaped. The shared execution log follows normal safe
retention; it was not truncated to erase test records. Temporary test files and
the isolated test database/container are removed. The retired 4GB template was
subsequently removed in the scoped follow-up above; the active catalog is retained.
