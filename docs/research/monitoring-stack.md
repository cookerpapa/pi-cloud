# Monitoring stack selection

## Decision

Retain the existing Prometheus, Grafana and Jaeger integration; add
Alertmanager and version-controlled Prometheus rules. Do not add a second
metrics pipeline, log database, host-wide privileged collector or OpenTelemetry
Collector to the default one-host topology.

## Evidence

- Prometheus separates rule evaluation from notification handling:
  Prometheus evaluates alert rules and Alertmanager groups, silences,
  inhibits and routes notifications. This directly fills PiCloud's missing
  alert lifecycle without changing application authority.
  <https://prometheus.io/docs/alerting/latest/overview/>
- Grafana supports file-provisioned data sources and dashboards, so the
  maintained dashboard remains reviewable and reproducible from Git.
  <https://grafana.com/docs/grafana/latest/administration/provisioning/>
- OpenTelemetry Collector is valuable for retry, batching, filtering and
  multi-backend export, but the official guidance also notes that direct export
  is adequate for small deployments. PiCloud currently exports one trace
  signal to one Jaeger backend, so another always-on service has no measured
  benefit yet. <https://opentelemetry.io/docs/collector/>

## Rejected default additions

| Candidate | Why it is not in the default profile |
| --- | --- |
| Loki / Elasticsearch | bounded Docker JSON logs already support one-host diagnosis; no retention/search requirement has been measured |
| node_exporter / cAdvisor | broad host or Docker visibility requires extra mounts/permissions; service process metrics and Cube capacity are the current product boundary |
| PostgreSQL exporter | the useful PiCloud queue/cleanup counts have domain semantics and are cheaper/safer to publish as bounded application gauges |
| NATS Prometheus exporter | PiCloud only needs two stream states and one durable consumer backlog; reading them through the existing authenticated JetStream client avoids another service |
| OpenTelemetry Collector | direct OTLP-to-Jaeger has one destination and low operational volume; add a Collector when multi-backend routing, buffering or redaction is measured |

This choice is intentionally reversible. Application metrics use Prometheus
format and traces use OTLP, so enterprise operators can insert their existing
collector or remote backends without modifying core Run, Session or Tool
protocols.
