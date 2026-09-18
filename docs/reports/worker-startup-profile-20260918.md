# Worker startup profiling and local fixes — September 18, 2026

Subsequent approved work: [atomic admission and its measured limits](atomic-admission-20260918.md).
The pending decision below describes this report's earlier revision.

Source baseline `33d381c6`, implemented/deployed `86d8a057`. One Compose Worker,
four family/model slots; unchanged PG/Kafka/Cube topology and durability settings.
**The measured blocking call is fixed, but paired tests do not demonstrate lower
overall startup latency. Further authority-transaction consolidation awaits owner approval.**

## Confirmed implementation issues

The main-thread CPU profile captured this stack:

```text
queue fillCapacity -> workerMemoryHeadroom -> process.constrainedMemory
```

A 34.7ms event-loop gap contained a 32.7ms profiler sampling interval at that
native function, with no overlapping GC observation. That is not 32.7ms of proven
on-CPU work. A separate paced test directly timed 1,000 calls on the actual Worker
under local regression load: median 0.091ms, p99 30.86ms, maximum 115.62ms.
Adjacent RSS/heap-stat reads stayed below 0.37/0.21ms. This is a synchronous OS
probe on a thread also responsible for Agent and database callbacks.

The OS limit probe now runs on one small internal sampling thread per Worker.
Fresh heap/RSS values retain the same 85% soft admission threshold. Missing,
failed or older-than-2.5s samples stop **new** families; existing-family/drain
semantics and OS hard limits remain unchanged. Sampling uses Node's public API,
not a custom cgroup parser or a new service. The post-fix main-thread CPU profile
contains no `constrainedMemory` call.

Lease issuance also re-read `lease_epoch` from a row it already held locked and
issued three final state writes separately. It now reuses the locked epoch and
sends those writes in one CTE. All locks, decision-time expiry checks, capacity
checks and transaction boundaries remain. A real-PG regression suppresses the
binding update and verifies rollback of epoch, capacity, Session version and lease.

## Honest latency result

Values are API submission → local Model Gateway upstream dispatch, excluding
remote model generation; they are not browser-paint measurements.
All paid requests used GPT-5.6 Sol, medium reasoning and Standard service.

| Workload | Warm follow-up median | Follow-up range | Four-Session waves |
| --- | ---: | ---: | ---: |
| Old Worker, no profiler | 134.4ms | 107.3–210.6ms | 136.6–319.5ms |
| Fixed Worker, matched no-profiler rerun | 137.4ms | 109.3–204.7ms | 153.7–379.5ms |
| Separate fixed functional acceptance | 110.3ms | 104.3–134.4ms | 122.5–275.4ms |

The matched comparison changed only the Worker image; Control Plane stayed on
the fixed revision. Each cohort had twelve sequential Turns including a 12s idle
gap, then two waves of four concurrent Sessions. Services were idle before image
replacement; builds/tests were stopped while timing. Cohorts are small and
sequential, not randomized capacity or tail-latency certification. Do not select
the faster standalone cohort and claim it as the paired improvement.

Other observed costs remain: first-use Pi provider lazy imports produced a roughly
45ms cold-start gap; a separate major GC took 27ms outside request startup.
Historical WAL-sync outliers are not proven eliminated by these changes.

## Remaining architectural decision

The maintained normal startup path still contains serial durable boundaries:

```text
API admission/commit
 -> Worker claim/commit -> lease/commit -> publication identity/commit
 -> Kafka opening ACK -> started/commit -> running/commit
 -> native Session restore -> operation/input ACK -> sampling-step ACK -> model
```

Optional World State/Compaction work is omitted. The final no-profiler cohort's
typical claim, lease, publication-opening and started/running stages were about
21, 15, 21 and 14/10ms respectively; publication includes Kafka, not just PG.
Phase medians are not additive, and not all of this time is disk fsync.

Proposed next step: atomically claim, bind the Session lease and register the
publication identity in **one PG execution-admission transaction**. Keep public
input admission separate, and all Kafka/network/model work outside that transaction.
Retain scope, seal, FIFO/capacity and UNKNOWN rules. This changes which intermediate
states survive a crash, so it is paused for discussion, not silently implemented.
Do not automatically fold later started/running/native-operation boundaries into it.

## Verification and cleanup

- 1,049 tests passed, three opt-in tests skipped; typecheck/build passed.
- 26 deterministic fault gates passed; installer, Helm/preflight, runtime budgets,
  observability, image closure and high-severity dependency checks passed. Existing
  two moderate development-only Vitest advisories remain.
- Five real GPT cohorts produced 106 Runs and 111 native assistant responses:
  119,996 input, 613,376 cache-read and 1,524 output tokens. Includes successful
  insertion-sort/binary-search shell tests and file reads, Worker restart/context
  recovery, and completed branch/fresh children in the parent's physical Session.
- Five test tenants, 47 conversation views, five Workspaces and their Run/native
  histories were removed after API purge and seal/projection/delivery checks.
  The original live Session/accounts remain. One test Cube was released; no
  development machine was allocated. Shared Kafka/formal logs were not truncated.
- The current Worker image was restored after the old-image comparison. Temporary
  baseline worktree/image, isolated test PG and private profiles/probes were removed.
  The temporary loopback-only Inspector was closed; no debugger port was published.
