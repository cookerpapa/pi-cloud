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
- Kafka consumer health and Gateway incomplete-tail sessions/events/bytes;
- logical Fact Stream utilization and Stream-lease renewal failures;
- settled terminal events still waiting to reach Kafka.

The Control Plane samples PostgreSQL and Kafka/Gateway state every ten seconds. These
samples are global gauges, so dashboards and alerts use `max`, not `sum`, when
several Control Plane replicas report the same authority state. A failed
sample does not take the product down; the last-success timestamp becomes
stale and triggers an alert instead.

Prometheus scrapes four application endpoint groups:

| Service | Internal endpoint | Main signals |
| --- | --- | --- |
| Control Plane | `control-plane:9464/metrics` | queue, event/session projection, cleanup, admission, process |
| Pi Workers | `*:9465/metrics` | active Runs, model/Run latency, tokens, process |
| Tool Broker | `tool-broker:9466/metrics` | Cube lifecycle, Tool calls, admission, process |
| Workspace Volume Gateway | `workspace-volume-gateway:9469/metrics` | storage queue, latency, rejection, process |

`pi_cloud_active_runs` counts Worker execution slots. The Pi adapter no longer
counts the same Run a second time. `pi_cloud_queued_runs` is sampled from the
shared PostgreSQL Run queue rather than inferred from a local Worker.

## Alert policy

Version-controlled Prometheus rules under `deploy/observability/alerts/`
detect unavailable targets, stale Kafka/Gateway sampling,
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
trusted path propagates it through Worker execution, model requests, Tool RPC,
Tool Broker and Cube lifecycle operations. Prompts, Tool output and provider
credentials are never span attributes. Jaeger is retained because it makes a
single slow/failed Run explainable; it is not required for alert correctness.

Services emit bounded structured JSON through Docker's logging driver. A
central log backend is intentionally not part of the default profile: one-host
operators can inspect `npm run production:logs`, while an enterprise
deployment can forward the same JSON with its existing Fluent Bit, Vector or
OpenTelemetry pipeline.

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
npm run production:config:observability
npm run production:up:observability
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:9093/-/ready
curl -fsS http://127.0.0.1:3001/api/health
curl -fsS http://127.0.0.1:16686/api/services
```

In Prometheus, check **Status -> Targets** and **Alerts**. The normal idle
baseline has all application targets up, bounded Gateway live-tail memory,
zero persistent projection/terminal/cleanup backlog, and no firing alert.
