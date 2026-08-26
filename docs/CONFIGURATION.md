# Configuration

PiCloud has three configuration surfaces. A setting belongs to exactly one of
them:

1. the administrator page for hot product settings;
2. the private one-host `.env` for restart-bound deployment settings;
3. Helm values and Kubernetes Secrets for distributed deployments.

Model keys and service credentials never belong in committed files.

## Hot administrator settings

The administrator page stores versioned values in PostgreSQL and applies them
to new requests without restarting services:

- model provider, model ID and encrypted API credential;
- Cube public-egress proxy URL and bypass list.

Configure the one-host administrator after registration:

```bash
npm run production:administrator -- --username <registered-username>
```

The command resolves the registered account, updates the private operator
tenant setting and recreates only the Control Plane. Sign in again afterward.

## One-host installer inputs

These flags apply only when creating or reconciling a host:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--runtime-dir` | `deploy/production/runtime` | private configuration, secrets and local state |
| `--cube-repository` | installer-managed path | pinned CubeSandbox checkout |
| `--bind-address` | `127.0.0.1` | Web/Preview listener on a fresh install |
| `--port` | `8080` | Web/Preview port on a fresh install |
| `--pi-workers` | `kubernetes` | trusted Worker pool mode: `kubernetes` or `compose` |
| `--skip-host-bootstrap` | off | require preinstalled host dependencies |

Existing bind/port/Worker mode is never silently overwritten. Use
`./install.sh --print-plan` or `./install.sh --check-only` before changing a
host.

## Restart-bound one-host settings

`npm run production:init` creates
`deploy/production/runtime/.env` with mode `0600`. Edit that file, validate it,
then recreate affected services with `npm run production:up`.

### Product and identity

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_HTTP_BIND_ADDRESS` | `127.0.0.1` | Web listener; use `0.0.0.0` only behind firewall/TLS policy |
| `PI_CLOUD_HTTP_PORT` | `8080` | Web listener port |
| `PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID` | empty | set by `production:administrator` |
| `PI_CLOUD_PUBLIC_REGISTRATION_ENABLED` | `true` | allow new browser accounts |
| `PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS` | `1000` | maximum public tenants |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS` | `10` | projects per public tenant |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS` | `100` | Sessions per public tenant |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS` | `10` | queued/running Turns per tenant |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS` | `4` | active Runs per tenant |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_ACTIVE_SANDBOXES` | `2` | active Cubes per tenant |
| `PI_CLOUD_WEB_SESSION_TTL_MS` | `2592000000` | browser login lifetime (30 days) |
| `PI_CLOUD_WEB_SESSION_COOKIE_SECURE` | `false` | set `true` when the public endpoint is HTTPS |

### Worker, Subagent and Sandbox capacity

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_SUPERVISOR_CAPACITY` | `2` | simultaneous Agent Loops per Compose Worker |
| `PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH` | `4` | recursive Agent-tree depth |
| `PI_CLOUD_SUBAGENT_MAXIMUM_NODES` | `32` | total descendants per root Run |
| `PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT` | `3` | active descendants per root Run |
| `PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES` | `2` | active Cubes owned by the one-host Broker |
| `PI_CLOUD_MAXIMUM_WARM_SANDBOXES` | `4` | idle warm Cube limit |
| `PI_CLOUD_SANDBOX_WARM_TTL_MS` | `900000` | idle warm lifetime (15 minutes) |
| `PI_CLOUD_TOOL_BROKER_OWNERSHIP_LEASE_MS` | `15000` | Broker replica ownership lease |
| `PI_CLOUD_TOOL_BROKER_OWNERSHIP_HEARTBEAT_MS` | `5000` | Broker ownership heartbeat |

To realize the full configured Subagent concurrency, tenant concurrency must
have room for the root Run plus those children; lower tenant quotas safely
reduce effective parallelism. Broker heartbeat must leave more than one missed
interval before lease expiry. `production:config` rejects incoherent lease
combinations.

### Streaming and Workspace operations

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_AGENT_EVENT_RETENTION_MS` | `86400000` | JetStream hot-event retention (24 hours) |
| `PI_CLOUD_MAXIMUM_HOT_EVENTS_PER_SESSION` | `8192` | bounded retained events per Session Subject |
| `PI_CLOUD_FACT_CHANNEL_LEASE_MS` | `9000` | short PostgreSQL ownership lease for one active accepted-Fact channel |
| `PI_CLOUD_FACT_CHANNEL_MAXIMUM_ACTIVE` | `128` | bounded active FactChannels per Control Plane replica |
| `PI_CLOUD_PREVIEW_ORIGIN_BASE_URL` | `http://preview.localhost:8080` | isolated application Preview base domain |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS` | `2` | trusted Volume operations in flight |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS` | `32` | bounded Volume wait queue |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS` | `30000` | maximum queue wait |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS` | `660000` | Broker-to-Volume request timeout |
| `PI_CLOUD_WORKSPACE_DELETION_REAPER_INTERVAL_MS` | `30000` | deleted-Workspace scan interval |
| `PI_CLOUD_WORKSPACE_DELETION_REAPER_BATCH_SIZE` | `16` | deletions considered per scan |
| `PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS` | empty | up to eight comma-separated RFC1918 `/24`–`/32` CIDRs that Cube guests may reach directly |
| `PI_CLOUD_CUBESANDBOX_REQUEST_TIMEOUT_MS` | `120000` | Cube lifecycle/control request timeout |

JetStream retention must cover a maximum Turn plus settlement grace. A cursor
already replaced by canonical PostgreSQL state receives HTTP 410 and reloads
the complete conversation. Volume queue wait must be shorter than its request
timeout.

Direct private CIDRs are frozen when a Cube is created. Commands receive the
same CIDRs and their exact IP members in `NO_PROXY`, so older HTTP(S) clients
that do not understand CIDR syntax still bypass the public-only egress proxy.
Existing warm or exclusive Cubes must be recreated to
pick up a changed list. This grants guest-initiated outbound access only; it
does not expose Sandbox ports to the private network.

### SSH and optional profiles

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_SSH_GATEWAY_ENABLED` | `true` | enable one-time-password SSH gateway |
| `PI_CLOUD_SSH_BIND_ADDRESS` | `127.0.0.1` | SSH listener |
| `PI_CLOUD_SSH_PORT` | `2222` | SSH listener port |
| `PI_CLOUD_SSH_ADVERTISED_HOST` | `127.0.0.1` | host shown to users |
| `PI_CLOUD_SSH_ADVERTISED_PORT` | `2222` | port shown to users |
| `PI_CLOUD_SSH_TICKET_TTL_MS` | `86400000` | maximum wait before an unused one-use password expires |
| `PI_CLOUD_PRODUCTION_PROFILES` | empty | comma-separated `observability` and/or `github` |
| `PI_CLOUD_PROMETHEUS_PORT` | `9090` | loopback Prometheus UI when observability is enabled |
| `PI_CLOUD_ALERTMANAGER_PORT` | `9093` | loopback Alertmanager UI when observability is enabled |
| `PI_CLOUD_GRAFANA_PORT` | `3001` | loopback Grafana UI when observability is enabled |
| `PI_CLOUD_JAEGER_PORT` | `16686` | loopback Jaeger UI when observability is enabled |

LAN/public SSH requires host firewall, stable host-key trust and explicit bind
and advertised addresses. `127.0.0.1` never changes automatically: set the bind
address to `0.0.0.0` and the advertised host to the server's routable IP or DNS
name. The UI offers a one-line `sshpass` command and a normal `ssh` command with
the password separate. The ticket remains one-use even though its default
unused lifetime is 24 hours. The GitHub profile is an infrastructure
experiment, not a complete PR product workflow.

## Safety-coupled one-host budgets

The one-host Compose profile fixes Tool, model, Turn and shutdown budgets as a
validated set. They are not ordinary `.env` knobs because increasing one may
make another service kill a still-valid operation. Current defaults are:

```text
model upstream request 120 s <= Pi model request 150 s <= Pi Turn 600 s
Tool Broker request 360 s
model capability TTL 900 s
Worker termination grace 720 s
Workspace Volume request 660 s < Volume gateway termination grace 720 s
```

Changing these requires editing the deployment policy and running
`npm run runtime-policy:check`; do not change only one container variable.

## Distributed Helm values

The distributed chart uses `values.yaml` for non-secret topology and a named
Kubernetes Secret for credentials. Important value groups are:

- `external.database`, `external.jetstream` and `external.providerProxyUrl`;
- `sandboxPlane` for Cube, Workspace storage and Broker/Volume capacity;
- `pi-workers.workerPool`, `autoscaling`, `runtime` and `lifecycle`;
- `networkPolicy.externalEgressCidrs`;
- `images` and `global.imageRevision`.

The database URL may use PgBouncer transaction pooling. The separate
notification URL must connect directly to PostgreSQL because `LISTEN` is
session-scoped. Workspace storage must support ReadWriteMany for replicated
Volume gateways.

## Validate changes

```bash
npm run production:config
npm run runtime-policy:check
npm run helm:check
```

Service startup validates individual ranges; the Compose wrapper additionally
validates cross-service concurrency, lease, retention and timeout relations.

## Secrets

Keep database URLs, model encryption key, Worker enrollment/management tokens,
Tool Broker token, Worker Event Ingest token, Cube API key, SSH host key and
NATS account/TLS material in the
generated private files or Kubernetes Secrets. Cube receives none of them.
