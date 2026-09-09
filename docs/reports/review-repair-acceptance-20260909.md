# Review repair acceptance — 2026-09-09

Implementation: `4f10f348`; browser dependency preparation and strengthened live
checks: `59b0ea55`. Production schema 135, execution log v7, SSE presentation v2.

## Resolved findings

1. Opening commits are idempotent across lost PostgreSQL replies, rollback and
   competing consumers. Adopt the first durable position; never cache an
   unconfirmed negative opening. Ordinary deltas add no PG authority read.
2. Child detail queries use qualified aliases. Actual HTTP/PGlite tests cover
   fresh and inherited lanes and foreign-tenant denial; real DeepSeek checks
   additionally opened all eight generated Child details, including an inherited
   lane after its isolated Workspace was removed.
3. Semantic projection co-commits event/native display coverage. Complete active
   Run messages are readable from PG; their spans leave memory before Run end.
   An uncovered suffix that repeats earlier canonical text remains exact after
   interruption. Borrowed reader references survive cache eviction.
4. Snapshot v2 is a materialized conversation, incrementally framed rather than
   one giant JSON frame or a raw delta replay. Normal small live events remain
   immediate. Slow writes disconnect only their reader after 30 seconds. Initial
   history is 40 Turns; older pages, navigation and complete export use Turn
   identity, not a browser Kafka cursor.
5. Retired fault targets and architecture ADR-0111 were removed. The maintained
   fault gate requires passed assertions from Vitest JSON reports and now runs
   in CI. Current architecture/deployment/stream documentation was synchronized.

The incremental JSON dependency also exposed a legitimate `__proto__` key-loss
bug. A fixed-version/source-checked one-line merge correction preserves JSON
properties in ESM/CJS; the Web image explicitly applies dependency preparation.
The deployed browser bundle was inspected for that correction. This adds no
message signature, new broker, per-token database write or compatibility decoder.

## Deterministic and deployment checks

- Full single-worker Vitest: **750 passed, 3 explicit environment-dependent
  skips**, 131 passing files.
- All-workspace typecheck, formatting, documentation, runtime budgets,
  distributed values and image closure checks passed.
- Large snapshot test: over **20 MiB**, including Unicode/escapes, through frames
  bounded at 128 KiB; no replayed text events. Mid-value disconnect discards the
  partial value and applies only the complete replacement.
- Complete large Tool input round-trips once, including ordinary own
  `__proto__` properties; prototypes remain unchanged.
- HTTP pagination verified 45 accepted prompts in ordered 40/5 pages, with a
  foreign history anchor denied. Reconnect retains loaded older history; new
  live output is not duplicated or replaced by peer-input metadata.
- A 2,048-fragment message compacts to one span and is evicted at semantic
  commit; the later repeated-prefix interruption is preserved in PG.
- Database was privately backed up before migration. No active lease or pending
  seal existed at rollout. Matching CP/Workers/Web started healthy.

## Real model and browser acceptance

- GPT/Cube production acceptance: 24 model usage records, 44,996 input,
  3,469 output and 233,472 cache-read tokens. Pure chat used no Cube; successive
  coding Runs reused a VM and background process. Authenticated Preview and
  persistent-Volume reattachment to a new VM passed.
- DeepSeek Subagents: fresh/branch, lazy Tools, shared/isolated Workspace,
  parallel and two-level recursive lanes passed. Eight actual Child detail
  responses matched their inherited-context anchors.
- Full browser check passed **92 controls**, including login/language, model
  selection, Fast/reasoning, copy/export, Steer/Stop, prune/Fork/tree, file browser,
  terminal, directory creation, machine pause/resume/release and SSH tickets.
- A real model built Snake through 11 Tool calls. Host Preview returned HTTP
  200; browser Start, keyboard movement, Pause and Reset passed. Preparation
  activity/spinner survived a browser snapshot refresh and cleared afterward.
- Ten real follow-up replies, each immediately reopened, each used one snapshot
  request and kept its text. This is a focused reconnect test, not another
  complete 92-control pass.
- Real Control Plane replacement: **29 records** were appended while Projector
  was down; one Attempt completed after replay. Fault duration measurement was
  22,993 ms and included 16 SSE reconnect attempts during deliberate downtime.
- Four tenants/eight DeepSeek Runs: all completed, four context markers
  restored, four cross-tenant API reads denied, zero marker leaks or extra
  attempts. Text TTFT p50/p95: **1.472/4.191 s**; queue p95: **3.165 s** with the
  current two ordinary parent slots. This is not a 1,000-Run capacity claim.

Across all generated test tenants (including intentional cancellation and repeat
checks): **62 Runs, 123 native usage records, 240,526 input tokens, 25,608 output
tokens and 944,128 cache-read tokens**. No unreported million-token real compaction
or physical multi-node HA experiment is claimed; compaction/recovery contracts
were exercised in the deterministic suite.

### Observed intermittent condition

The first browser pass observed two snapshot requests when reopening a completed
conversation. It did not recur in the full rerun, ten consecutive reopenings,
or ten new-reply/immediate-reopen cycles. Passive CDP network diagnostics and the
strict one-request assertion remain in the test. The initial cause was not
confirmed and is **not** claimed fixed. No assertion was weakened to obtain a pass.

## Cleanup

Confirmed storage purge for all **18 test Workspaces** and release of both test
development machines before removing metadata. Deleted only the 13 generated
tenants and 34 Session scopes plus the explicitly named foreign-test Project.
Normal PG foreign-key checks remained enabled; test-only reference cycles were
cleared inside one transaction before dependency-ordered deletion.

Inspected every retained target Kafka offset: all **1,987 records** belonged to
test tenants, then deleted that prefix. Original IDs were compared, not merely
row counts: all **35 users, 52 Sessions, 48 Workspaces and 48 Projects** remain,
with no extra test entities. Temporary test files/screenshots/downloads were
removed; aggregate reports and the private pre-migration backup are retained.

See [ADR-0165](../adr/0165-message-level-display-and-framed-snapshots.md),
[fault gate](fault-eval-latest.md), [browser](browser-ui-acceptance-latest.json),
[Snake](snake-preview-acceptance-latest.json),
[Subagents](subagent-production-acceptance-latest.json) and
[multi-tenant load](multi-tenant-model-load-latest.json).
