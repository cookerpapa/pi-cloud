# ADR 0201: runtime activity, path probes and independent lease sweeps

Status: implemented and validated, 2026-09-30.

[Acceptance](../reports/runtime-status-acceptance-20260930.md) includes deterministic
faults, real Luna/Cube/browser execution, Projector replacement and Worker loss.

## Context and adoption

An active turn can be silent while awaiting a model, Tool or child. Browser SSE
keepalives establish only browser connectivity. PG lease renewal establishes
execution authority, not successful passage through Kafka and Projector.
The existing maintenance loop also waits for remote Worker retirement before
scanning expired Session leases, and its initial candidate filter uses API time.

[Prometheus instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/#offline-processing)
recommends timestamped heartbeats through multistage pipelines, with ordinary
traffic sufficient when there are no quiet periods.
[LinkedIn's Kafka Monitor](https://www.linkedin.com/blog/engineering/open-source/open-sourcing-kafka-monitor)
documents production use in 2016. Its separate synthetic pipeline measures
cluster health, not our Session publication and application projection path.
We adopt this monitoring pattern using the existing pinned Kafka client,
HTTP/SSE transports and metrics. No new telemetry framework, consumer group,
scheduler, queue or durable health authority is needed. The bounded application
instrumentation is necessary to observe the actual Session path.

## Decision

1. Run short database expiry sweeps independently of remote Worker retirement.
   Both loops are bounded and non-overlapping within themselves; retirement
   retains the existing durable claims, fencing, retry and remote-call deadlines.
   Initial Session expiry selection and locked final decisions use PG time.
2. Show a persistent status for every active turn, using observed runtime phases
   and last actual activity. Native Pi events stay inside the trusted Runner;
   the public observation schema is PiCloud-owned. Existing Tool preparation,
   Tool progress, retry and Compaction presentation remain useful inputs.
3. During active Session silence, send a small, low-frequency path probe through
   the same publication path, Session partition and Projector as real records.
   Ordinary records also provide path observations. Probes carry identity and
   freshness, never model text, Tool arguments, partial JSON or reasoning.
4. This probe is an explicit exception to observation-only HTTP/SSE transport:
   it must traverse Kafka to measure that path. It is not a native Pi Entry,
   public transcript event, PG history row, Tool command or model-context item.
   New ordinary phase/activity observations use lossy HTTP/SSE. Health memory
   is bounded and disposable; restart/reconnect may return it to unknown.
5. Observations cannot renew a lease, cause task recovery, authorize an effect,
   or reopen a terminal turn. Old identities, replayed positions and stale
   timestamps cannot refresh current health. Missing probes mean delayed or
   unavailable path evidence, not proof that the Agent has stopped. A healthy
   path does not prove that the provider or guest has made progress.

## Acceptance

- Stalled retirement does not delay lease sweeps; slow cycles never overlap.
- PG expiry selection survives application clock skew and renewal races.
- Phase observations cover model waits, Tool preparation/execution, child waits,
  retry, Compaction and cancellation without disclosing private model content.
- Probes use bounded queues and the real Session path; no per-Lane amplification,
  per-probe history write or per-Step acknowledgement is introduced.
- Delayed/replayed probes, Projector reassignment, Worker loss, cancellation and
  terminal races cannot fabricate activity or revive execution.
- Browser status remains visible across silent model intervals, becomes uncertain
  on stale evidence, and is removed when the authoritative turn becomes terminal.
- Relevant unit, PostgreSQL and process-failure checks, followed by real GPT-6
  Luna/Cube/browser acceptance. Evidence names revision and tested topology.

Matched Worker/Control Plane/Web deployment is required for the new Kafka record
kind and SSE observations. Stop/drain Workers and catch projection up before
replacing the matched application set. A pre-0201 reader cannot decode probes:
rollback requires quiescence and verification that its recovery range contains
no probes (or a deliberate topic-generation cutover), not simply starting an old
consumer. Prefer a matched forward repair. Native PG history is unchanged and
remains exportable through the existing storage adapter.

Concrete bounds: one probe per quiet physical Session at most every 15 seconds,
and no probe until an ordinary record has been acknowledged. No overlapping
probe per family and no synthetic public/native sequence. Freshness expires at
45 seconds; clocks over five seconds in the future cannot refresh health.
Age uses the original publication timestamp, not replay receipt time. Worker
and Control Plane wall clocks must be synchronized for this diagnostic; execution
authority always uses PG time independently. HTTP activity coalesces to the
latest state, sends at most once per second per Run and republishes quiet phase
state every 15 seconds without advancing the last actual activity timestamp.
There are at most four one-second HTTP sends in flight per Worker, with fair
rotation; delivery failures drop observations. The existing Worker management
credential protects ingress. Projector checks already-admitted scope/partition
in memory, without a per-observation SQL query. Probe processing uses cached
publication/closure checks, never native projection or external-effect routing.
