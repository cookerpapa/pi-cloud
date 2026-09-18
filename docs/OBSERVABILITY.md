# Monitoring and observability

PiCloud uses a deliberately small optional stack:

```text
application / process metrics -> Prometheus -> Alertmanager
                                      |
                                      v
                                   Grafana

application traces ----------------> Jaeger
bounded JSON logs -----------------> Docker logging driver
```

Run it with:

```bash
npm run production:up:observability
```

The loopback-only operator endpoints are:

| UI | Default URL | Purpose |
| --- | --- | --- |
| Grafana | `http://127.0.0.1:3001` | primary health/capacity dashboard |
| Prometheus | `http://127.0.0.1:9090` | targets, queries and alert rules |
| Alertmanager | `http://127.0.0.1:9093` | active alerts, grouping and silences |
| Jaeger | `http://127.0.0.1:16686` | one-Run cross-service traces |

Grafana's administrator password is stored in the private runtime secrets
directory. Metrics endpoints are bearer-protected on the internal
observability network. None of these operator ports is public by default.

## What is monitored

The default dashboard and alert rules cover failure modes that affect a
user-visible Run:

- service scrape health and process CPU/memory/event-loop metrics;
- ready Run backlog, queue wait, Run throughput, latency and failure rate;
- provider/model latency and Pi-native token observations; Provider Gateway
  account quota and cooldown remain visible in CLIProxyAPI's native page;
- Tool failures and Cube lifecycle/admission capacity;
- Workspace Volume Gateway queue, latency, rejection and cleanup backlog;
- Session Projector incomplete-tail sessions/events/bytes;
- direct Kafka Producer queue occupancy/rejections and Session-owner lease failures;
- settled terminal events still waiting to reach Kafka.

Each Control Plane samples PostgreSQL and its local Projector every ten seconds.
PG queue/cleanup gauges describe shared state, so use `max`, not `sum`, across
replicas. Live-tail gauges describe local memory; their `max` is the largest
replica, not total backlog or Kafka consumer lag. The `source="kafka"` sampling
timestamp means local Projector statistics were read, not that Kafka was probed.
A failed sample leaves its last-success timestamp unchanged. Freshness and missing
samples are checked per replica so a healthy sibling cannot hide a failure.

Prometheus scrapes four application endpoint groups:

| Service | Internal endpoint | Main signals |
| --- | --- | --- |
| Control Plane | `control-plane:9464/metrics` | queue, event/session projection, cleanup, admission, process |
| Pi Workers | `*:9465/metrics` | active Session families/Lanes, model permits/wait, Run latency, tokens, process |
| Tool Broker | `tool-broker:9466/metrics` | Cube lifecycle, Tool calls, admission, result-cache bytes/releases, process |
| Workspace Volume Gateway | `workspace-volume-gateway:9469/metrics` | storage queue, latency, rejection, process |

`pi_cloud_active_session_families` counts occupied Worker slots;
`pi_cloud_active_runs` counts the active Lane tasks within those families.
`pi_cloud_model_permits_active` and `_waiting`, plus
`pi_cloud_model_permit_wait_seconds`, distinguish provider work from local model
admission. A task waiting for a child/Tool holds no model permit.

`pi_cloud_run_preparation_seconds` measures post-admission preparation, durable
started and Kafka log opening. Lease subphases now belong to the single claim
transaction below; there is no production `execution_lease`/`lease_commit`
boundary. Correlate outliers with PostgreSQL wait events before attributing them
to storage or locks. Labels contain neither tenant identity nor SQL/parameters.
`pi_cloud_queued_runs` is sampled from the
shared PostgreSQL Run queue rather than inferred from a local Worker.

`pi_cloud_run_claim_stage_seconds` splits successful claims into transaction
acquisition/BEGIN, candidate selection, context/configuration reads, locked
ownership selection, lifecycle writes, `lease_*` checks/binding,
`publication_registered` and final mapping/COMMIT. Its only label
is the code-owned stage; it records no query parameters, tenant or Session IDs.
Idle scans and rolled-back claims remain in `pi_cloud_run_claim_seconds` and do
not enter these successful-claim stage samples. Compare stage sums over the
same measurement interval before changing admission rules or pool sizes.

`run.claim.timing` records each successful admission's Run/Attempt identity,
start time, monotonic duration and the existing claim subphases. Bounded
`run.preparation.timing` records correlate started/running commits, log opening,
Session/model preparation and initial World State with that Run. They contain no
SQL, prompt or result data and add no persistence barrier. Start/end intervals
must be aligned with `model.transport.timing`; overlapping Session/model spans
and nested claim stages must not be summed as serial work. IDs remain log fields,
not metric labels. Diagnostic sink failure cannot change execution outcomes.

`database.slow_commit` reports acknowledged COMMIT calls taking at least 100ms,
with backend PID, client elapsed time and event-loop active/idle time. It adds no
SQL, parameter logging or new persistence barrier. A client duration is not a
disk measurement: correlate its timestamp with PG wait events and process GC/CPU
evidence. Idle time can include server or network wait; active time is not proof
of GC. Rejected/uncertain commits remain execution errors, not success diagnostics.

Transport capacity signals are process-local and should be summed across replicas:

- `pi_cloud_kafka_producer_pending_bytes` / `_pending_facts`: queued and submitted
  Facts awaiting PubAck; `_rejected_total` counts rejection before enqueue.
- `pi_cloud_tool_result_readers` / `_sending_bytes`: outstanding HTTP deliveries;
  cache bytes remain a separate gauge. `pi_cloud_tool_transport_rejected_total`
  distinguishes command, reader and response-byte capacity.
- `pi_cloud_tool_log_consumed_total` counts each router's partition reads;
  `pi_cloud_tool_log_delivery_seconds{route="local"|"remote"}` measures owner
  admission, excluding guest execution. Its outcome distinguishes delivery,
  retry and abandoned dead-owner delivery. Compare these with Kafka group lag.
- `pi_cloud_session_mutation_wait_seconds{stage="kafka_publish"}` measures native
  append acknowledgement, excluding model time. There is no active
  `projection_receipt` stage; PG projection lag is a cloud-consumer concern.
- `pi_cloud_session_view_reads_total{source="storage"|"memory"}` and
  `pi_cloud_session_view_read_seconds` distinguish cold branch loads from
  committed in-memory snapshots. `pi_cloud_session_view_storage_bytes_total`
  estimates materialized Entry JSON bytes, not PostgreSQL wire traffic. There
  are no Session-ID labels; the shared writer is retained while its family is active.

The Session Projector runs in Control Plane and uses its authenticated metrics
endpoint. There is no separate Projector metrics service or renewable output-stream lease.

## Alert policy

Version-controlled Prometheus rules under `deploy/observability/alerts/`
detect unavailable targets, stale or missing per-replica sampling,
persistent Run/session/event backlogs, Cube/Volume saturation, storage cleanup
backlog and elevated Run failures. Thresholds are conservative starting
values for the one-host profile; change them only with measured workload data.

The repository deliberately ships no email/chat vendor credentials.
Alertmanager's default receiver keeps alerts visible in its UI and supports
silences. An operator should replace `operator-ui` in
`deploy/observability/alertmanager.yml` with the organization's existing
email, webhook or on-call receiver before relying on unattended notification.

## Traces and logs

The Control Plane assigns a W3C trace identity to each accepted Run. The
trusted path propagates it through Worker execution, model requests, Kafka Tool commands,
Tool Broker and Cube lifecycle operations. Prompts, Tool output and provider
credentials are never span attributes. Jaeger is retained because it makes a
single slow/failed Run explainable; it is not required for alert correctness.

Services emit bounded structured JSON through Docker's logging driver. A
central log backend is intentionally not part of the default profile: one-host
operators can inspect `npm run production:logs`, while an enterprise
deployment can forward the same JSON with its existing Fluent Bit, Vector or
OpenTelemetry pipeline.

Each authorized model HTTP request emits one `model.transport.timing` record,
not a log per token. It identifies the Run/Step and records request receipt,
upstream dispatch/headers, first byte, first parsed frame, first nonempty text,
Tool preparation and hosted-search activity when present. Durations are measured
on the same monotonic clock; `receivedAtMs` permits correlation with the UI/Run
timeline on clock-synchronized hosts. No prompt, response text or Tool arguments
are logged. `transportCompleted` means the HTTP body ended, not that the model
or Run succeeded. Upstream timing includes CLIProxyAPI and its provider route;
it is not a measurement of the provider's internal inference alone.

## Privacy and cardinality

- no tenant, Session, Run, prompt, path, repository or exception text is a
  Prometheus label;
- stream, consumer, service, operation, model and outcome labels come from
  bounded deployment-owned sets;
- logs recursively redact token, authorization, credential, password, secret,
  cookie and API-key fields;
- durable usage rows, not Prometheus counters, remain any future billing
  authority.

## Verification

```bash
npm run observability:check
npm run production:config:observability
npm run production:up:observability
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:9093/-/ready
curl -fsS http://127.0.0.1:3001/api/health
curl -fsS http://127.0.0.1:16686/api/services
```

In Prometheus, check **Status -> Targets** and **Alerts**. The normal idle
baseline has all application targets up, bounded Projector live-tail memory,
zero persistent projection/terminal/cleanup backlog, and no firing alert.
