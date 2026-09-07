# Ordered execution stream seal acceptance

Date: 2026-09-07. Candidate based on `a5ab40f4`; reports mark the working tree
as modified. Protocol: [ADR-0154](../adr/0154-ordered-execution-stream-seals.md).

## Result

The previously reproduced late-publisher branch overwrite is fixed on both
canonical and SSE paths. Run business settlement requests an execution seal;
the successor cannot claim until its ordered canonical projection completes.
Periodic lease progress no longer allocates the terminal event sequence.

The empty Run-start projection barrier and optional terminal-prefix HTTP RPC
have been removed, rather than retained alongside the seal.

## Real API / Worker fault injection

Command: `PI_CLOUD_LIVE_WORKER_HANDOFF_CHECK=1 node scripts/run-worker-handoff-check.mjs`.
Three successive real DeepSeek campaigns passed during implementation. The
[latest machine-readable report](worker-handoff-probe-latest.json) includes:

- authenticated frontend API client, real PiWorkerRuntime/Pi SDK, actual PG
  queue/lease/maintenance reconciliation, RF=3 Kafka and browser SSE client;
- ordinary Follow-up remains queued and native Steer consumption works;
- ingress pauses after authority admission but before complete assistant append;
- canonical consumer closes/rejoins while the old prefix is still unsealed,
  rebuilding it despite previously committed consumer offsets;
- ingress stays paused for 12 seconds, exceeding its 9-second lease;
- SIGKILL only the isolated Worker A; normal reconciliation fails its Run;
- Worker B starts after the old seal commits and receives the visible partial
  assistant text in its actual provider request;
- resume ingress A: the late complete mutation is present in Kafka but neither
  changes the Pi lane head nor appears in SSE;
- restart the canonical consumer again: replay preserves that head.

Latest run made five real provider requests. Four persisted usage records total
31,283 tokens including cache reads; the killed response's usage is not included.
This is not a billing estimate. Each campaign used a private disposable database,
Kafka topic/groups and isolated child processes, all removed afterward.

Steer delivery is still distinct from consumption: a Steer delivered just before
the Worker dies remains in the durable control mailbox, but is not automatically
replayed into the next prompt. No arbitrary Tool operation is automatically retried.

## Deployed Cube / browser coding check

Command: `PI_CLOUD_LIVE_TOOL_PREPARATION_CHECK=1 node --import tsx scripts/run-live-tool-preparation-check.mjs`.
After deploying the new Control Plane and both Workers, DeepSeek used `write`
to create sorting/search code and tests, ran Python in Cube, then used `edit` to
extend the same file and reran the tests. The browser was refreshed during Tool
generation and recovered the preparation indicator and final output.

| Round | Total elapsed, including model | First visible Tool preparation |
| --- | ---: | ---: |
| write + execute | 14.132 s | 1.684 s |
| read/edit + execute | 12.072 s | 2.386 s |

These are Tool-preparation timings, not assistant-text TTFT or a throughput claim.
Details: [browser acceptance](tool-preparation-acceptance-latest.json).

The test Workspace was deleted and its Volume purge confirmed. The exact test
tenant and account were removed afterward. Before/after production counts match:
35 users, 52 Sessions, one live Workspace. Existing user machines were untouched.
Shared production Kafka retains the bounded test records until normal retention;
it was not reset to erase one tenant's test stream. Reports contain no credentials
or full provider request/response bodies.

## Automated gates and limits

673 tests passed; three pre-existing environment-gated tests skipped. Added
coverage includes queued-successor gating, late canonical and live rejection,
stale-consumer transactional rejection, duplicate seal/ACK loss, immutable tail
snapshots, lost-prefix/retention fail-closed behavior, short receipt expiry without
lane rewind, and old-seal/new-Attempt isolation. Build and type checks pass.

The migration preserves PG conversations and uses a new bounded Kafka topic
generation. No rolling mixture of old and new publishers is supported.
Canonical recovery scans retained Kafka to rebuild volatile prefixes; it is not
an unlimited-outage recovery guarantee. This campaign did not test host power
loss, Kafka quorum loss, remote multi-node failover or physical Cube fencing.
The seal closes messages, not already running shell processes or external effects.
