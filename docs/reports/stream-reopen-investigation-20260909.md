# Intermittent double-request investigation — 2026-09-09

Deployed revision: `5e544c11`. Real production Web/Caddy/Control Plane, Kafka,
PostgreSQL and Workers; Chrome 145, one browser at a time. No service restart,
server delay injection, production code change or assertion relaxation.

## Outcome

The original unexplained reopening request pair **did not recur**. Across 197
unmodified-browser opening operations, each operation issued one Session SSE
request and each settled observation had one surviving connection. This is not
proof that the historical fault is fixed or that no future reconnect can occur.

Three additional, deliberately delayed-snapshot cases each produced two
**successive** requests, not persistent duplicate subscriptions. These exercise
an existing protection against overwriting a newly accepted user input with an
older snapshot. They do not establish the cause of the original incident: that
incident occurred after a completed reply, without evidence of concurrent input.

## Cases

| Scenario | Operations | Observation |
| --- | ---: | --- |
| Reopen completed conversation / alternate two conversations | 60 | One request each |
| Reload page through its Session deep link | 10 | One request each |
| Select before a new reply / reopen immediately after it completes | 40 | One request each; 20 real replies |
| Reopen during six longer responses, including before/after controls | 84 | One request each; 72 rapid reopenings |
| Select conversation before delayed-snapshot experiment | 3 | One request each |
| Deliberately hold snapshot while submitting new local input | 3 | Two successive requests each, one survivor |

Passive Chrome DevTools capture recorded request IDs, start/end times, HTTP
status, cancellation reason and SSE frame kinds/sequences. It did not change
the application fetch path in the 197 ordinary cases. All observed SSE responses
were HTTP 200; frame capture reported no errors. Ordinary observations settled
for 100–650 ms after opening, with a final two-second observation before teardown.

The delayed-snapshot test temporarily held one fetch response **only in the test
browser**, after the server had constructed the snapshot. It then submitted a
real message through the composer and released that response:

1. Snapshot A was requested before the input was accepted.
2. The accepted local input changed the browser's input revision.
3. On reading snapshot A, the existing guard cancelled it instead of replacing
   the newer UI state.
4. Snapshot B restored the newer state and continued streaming.

The three A requests ended with `net::ERR_ABORTED` after 228/226/226 ms. B started
3/2/2 ms **after** A ended. Every case had one surviving connection at its
observation point. The browser's local input revision is request invalidation,
not a Kafka offset, recovery cursor or execution authority.

## Paid model and deterministic evidence

- GPT-5.6 Sol and DeepSeek V4 Flash: **33 Runs completed**, 33 native usage
  records, **34,583 input / 7,441 output / 254,976 cache-read tokens**.
- The workloads were text-only; no Cube activation or development machine was
  required. This is not a new coding, Compaction, stress or HA acceptance claim.
- Existing stream server/client tests: **11 passed**, including incremental
  snapshots over 20 MiB, heartbeat continuity and slow-reader teardown.

## Reproduce and remaining question

```bash
PI_CLOUD_LIVE_STREAM_REOPEN_CHECK=1 node scripts/run-live-stream-reopen-check.mjs
PI_CLOUD_LIVE_STREAM_REOPEN_CHECK=1 PI_CLOUD_REOPEN_OUTPUT=.cache/stream-reopen-timing \
  node scripts/run-live-stream-reopen-check.mjs --timing-only
```

The second command includes the intentional input/snapshot race, separately
classified as an expected reconnect. The script deletes its conversations and
Workspaces through public APIs; private diagnostic scope files identify its
account/metadata for operator cleanup. Never infer a leak from request count
alone: distinguish an old request being cancelled, a server-ended stream being
retried, and two live subscriptions continuing simultaneously.

No speculative production fix was applied. To explain the original incident,
the missing evidence is its first request's termination reason and the associated
browser input/action timeline. The retained focused diagnostic and existing full
browser one-request assertion keep that question observable.

## Cleanup

Both generated Workspace storage purges completed. Test conversations, accounts
and associated tenant metadata were removed with normal foreign-key checks; the
original 35 users, 52 Sessions and 48 Workspaces were preserved. Temporary raw
diagnostics were removed after extracting this aggregate report. Every retained
Kafka record in the selected prefix was inspected: all 2,389 belonged to these
test tenants. Only that validated prefix was deleted; later appends were outside
the captured deletion bounds.
