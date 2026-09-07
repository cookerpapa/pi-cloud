# Public API / Pi Worker handoff validation

Date: 2026-09-07. Application revision: `c9c4376a`. Production implementation
was not changed. Final probe started at 07:48 UTC; an earlier complete run at
07:43 UTC reached the same late-publication result.

## Scope and method

```bash
PI_CLOUD_LIVE_WORKER_HANDOFF_CHECK=1 node scripts/run-worker-handoff-check.mjs
```

The probe composes the production authenticated REST API, PiWorkerRuntime,
Pi SDK, PostgreSQL Run queue and SessionLeaseCoordinator, Supervisor maintenance,
management HTTP, AssignmentReconciler, FactChannel ingress, Kafka projection
and cursor-free SSE. It uses the frontend's PiCloudApi client for registration,
Workspace/Session creation, messages and Steer. PostgreSQL is disposable and
Kafka uses a private RF=3 topic/consumer groups. Ingress is a separate process
for fault isolation; API, projection and maintenance remain reachable. This is
isolated component-level end-to-end wiring, not a power-loss test of the user's
single-host production deployment.

Two distinct Worker processes use the ordinary production runtime and native
queue claim. After Worker A is killed, the existing maintenance path ends its
Run; Worker B then claims the queued Follow-up. There are **no direct SQL writes
to Run, Attempt, Session state or Lease for takeover**. Bootstrap creates only
the usual initial operator tenant. Pure conversation calls real DeepSeek V4
Flash Responses through the existing Provider Gateway. No Cube is needed or
allocated; this does not validate Tool side-effect recovery.

The two ingress processes expose ordinary authenticated FactChannel WebSockets.
A test-only bus-port hook pauses one process immediately before forwarding the
complete assistant mutation to Kafka. It does not change that mutation, bypass
the Authority Gate, alter consumer results or modify production source. A
Provider relay records only in-memory marker presence to check model inputs;
no prompts, response bodies or credentials enter the report.

## Results

| Assertion | Observed result |
| --- | --- |
| Follow-up while first Run is active | queued; not yet a native Pi user Entry |
| Steer during ordinary execution | delivered, native user Entry precedes Follow-up, marker reaches the model |
| Normal Follow-up execution time | starts only after first Run settles |
| Pause ingress for 12 seconds, keep Worker A alive | first Run remains running; Follow-up remains queued |
| Kill Worker A after that pause | maintenance expires one connection and retires one Worker; first Run becomes failed with `assignment_lost` |
| Start Worker B | new boot identity, ordinary queue claim, queued Follow-up completes |
| Resume old ingress only after Follow-up completes | old complete assistant mutation projects successfully and becomes `main` lane head |

Thus the user's FIFO objection is correct: the second Run does not race a still
running first Run. The gap is **after the first Run is legitimately failed**:
its formerly admitted, not-yet-persisted output can arrive after recovery.
Waiting for a Run terminal state does not itself seal every old publisher.
This follow-up establishes reachability through real queue/retirement behavior,
which the previous fixture-only probe did not establish.

Machine-readable result: [worker-handoff-probe-latest.json](worker-handoff-probe-latest.json).
The final run made five paid Provider requests: 1,327 input, 34,816 cache-read
and 1,852 output tokens. These are native usage counters, not a billable-cost
estimate; setup/debug repetitions are excluded from this final-run total.

## Steer observation, not an automatic replay requirement

In the faulted Run, Steer returned `delivered` and its control row remained
`completed`. Its text was still stored in PostgreSQL, but it had not become a
native user Entry before Worker death and was not included in Worker B's model
request. Ordinary delivery is currently an acknowledgement of the Pi in-memory
queue, not durable consumption by the model.

This is not evidence that the input bytes were lost. Whether an unconsumed
Steer targeting a failed Run should be surfaced as unconsumed, offered as a
Follow-up, or otherwise retained for user action needs an explicit policy.
Automatically replaying it into a different Run has not been authorized or
implemented by this validation.

## Additional timing-sensitive stream failure

The 07:43 run (kill immediately after the pause) recorded a live-tail conflict:
its `turn.failed` event used sequence 203, already occupied by another event.
The consumer reported `partition.stalled`. The later 12-second-pause variant
did not record this conflict, so it is not a deterministic symptom of every
handoff. The observed excerpt is retained in
[worker-handoff-stream-conflict.json](worker-handoff-stream-conflict.json).

Relevant code: terminal preparation requires the live prefix endpoint to equal
the last PostgreSQL progress checkpoint. AssignmentReconciler catches a failed
prefix preparation and still settles; terminal allocation uses persisted
progress. That combination needs a separate exact-boundary regression when
checkpoint progress trails already accepted stream data. No arbitrary events
were skipped and no stream-generation fix was added to hide the observation.

## Cleanup and next decision

All test subprocesses, temporary PostgreSQL/container data and private Kafka
topic/groups were removed. Production services, users, Sessions, Workspaces,
Cube machines and credentials were not changed. A debug repetition exposed a
test cleanup wait on a child already killed by a signal; the harness now checks
both `exitCode` and `signalCode`. That repetition's exact resources were removed
before the complete reruns.

Publication handoff and terminal stream boundaries still require a design
decision. Ordinary input mailboxing is retained; neither append-only Session
storage nor FIFO needs to be removed based on these findings. The broader
broker-loss, physical multi-node, retention, capacity and long-context campaign
is still pending, not implied by this focused test.
