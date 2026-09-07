# Late publisher changes a recovered Session lane

Status: blocking correctness counterexample; production code unchanged.
Base revision: `be748b39`. Date: 2026-09-07.

The validation campaign stopped at its first architecture-level failure. Other
requested crash, scale, retention and long-context gates have not been newly
validated by this campaign. Prior passing reports retain their original scope.

The initial probe below used direct fixture authority replacement and did not
prove a reachable Run takeover. A subsequent [public-API/Pi-Worker validation](worker-handoff-findings.md)
now confirms the gap after real failure reconciliation while also confirming
that ordinary Follow-up serialization and Steer consumption work.

## Reproduction

```bash
PI_CLOUD_LIVE_LATE_PUBLISHER_CHECK=1 node scripts/run-late-publisher-check.mjs
```

The command exits nonzero if the recovered lane changes after the old publisher
resumes. It creates a disposable full-schema PostgreSQL server and a private
RF=3 Kafka topic, uses production FactChannel/Authority/Kafka/consumer/Session
projection classes, and suspends a separate Node ingress process with SIGSTOP.
It does not modify or stop production PiCloud services, call a model or create
a Cube. Atomic SQL fixture replacement after both lease deadlines expire stands
in for authority takeover; the full Run reaper/Worker claim is not tested here.

The fault hook is at `AcceptedFactBus.append`, after the final authority check
and before durable append. This is a controlled process scheduling point, not
a fake Kafka response or a mocked PostgreSQL projection.

Observed Kafka order, within a single Session-keyed partition:

| Offset | Authority generation | Fact |
| --- | --- | --- |
| 0 | 2 | replacement's recovery barrier, then successfully projected |
| 1 | 2 | replacement's new message, then successfully projected |
| 2 | 1 | old ingress resumes and appends its previously admitted message |

PostgreSQL still identifies generation 2 as current. Nevertheless the old
message is projected, its `parentId` points to the replacement's message,
and `main.leafId` changes to the old message. The replacement could already
have loaded model context before this late addition. The updated probe adds
a final observation barrier so it can also pass if a future fix rejects the
old publication; it does not require the old receipt to exist.

Independent executions at 05:49, 05:51 and 05:55 UTC all reproduced this ordering.
The machine-readable latest execution is in
[late-publisher-probe-latest.json](late-publisher-probe-latest.json).

## Cause and decision needed

The current lease excludes new admissions, but does not fence the Kafka producer
after admission. Lease expiry plus a new recovery barrier orders only records
that have reached Kafka; it cannot retract or order another process's in-flight
work. Normal stream-close draining has no opportunity to run while that process
is suspended or unreachable.

A new authority query immediately before sending still has the same pause
window. Rejecting every old generation during projection is also not a neutral
fix: facts durably accepted before takeover still need to be recovered even
after their lease expires. The publication-generation handoff contract must
be decided before changing this behavior. No production fencing/projection
policy has been silently changed to make the test pass.

Temporary database/container and topic data are removed after each probe.
No user Session, Workspace or machine was involved. Early probe versions left
empty consumer-group metadata subject to Kafka cleanup; the maintained probe
explicitly removes its uniquely named consumer group as well.
