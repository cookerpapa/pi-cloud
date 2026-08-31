# Configuration

PiCloud has four configuration surfaces. A setting belongs to exactly one of
them:

1. the PiCloud administrator page on port `8081` for hot product settings;
2. CLIProxyAPI's native management page on port `8318` for provider accounts;
3. the private one-host `.env` for restart-bound deployment settings;
4. Helm values and Kubernetes Secrets for distributed deployments.

Model keys and service credentials never belong in committed files.

## Hot administrator settings

The administrator page stores versioned values in PostgreSQL and applies them
to new requests without restarting services:

- Pi provider/model route, without an upstream credential;
- Cube public-egress proxy URL and bypass list.

CLIProxyAPI is the only model-supply authority. Its private Volume contains
ChatGPT OAuth records and API keys; its native page manages quota, cooldown and
account health. PiCloud stores only the selected provider/model route. Use:

```bash
npm run production:provider-gateway:key
npm run production:provider-gateway:codex-login
```

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
| `PI_CLOUD_ADMIN_BIND_ADDRESS` | `127.0.0.1` | operator-only listener bind address |
| `PI_CLOUD_ADMIN_PORT` | `8081` | PiCloud operator landing page |
| `PI_CLOUD_CLI_PROXY_MANAGEMENT_PORT` | `8318` | native Provider Gateway management page |
| `PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID` | empty | set by `production:administrator` |
| `PI_CLOUD_PUBLIC_REGISTRATION_ENABLED` | `true` | allow new browser accounts |
| `PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS` | `1000` | maximum public tenants |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS` | `10` | projects per public tenant |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS` | `100` | Sessions per public tenant |
| `PI_CLOUD_WEB_SESSION_TTL_MS` | `2592000000` | browser login lifetime (30 days) |
| `PI_CLOUD_WEB_SESSION_COOKIE_SECURE` | `false` | set `true` when the public endpoint is HTTPS |

### Worker, Subagent and Sandbox capacity

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_SUPERVISOR_CAPACITY` | `2` | simultaneous Agent Loops per Compose Worker |
| `PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS` | `4` | bounded PostgreSQL pool per Compose Worker; tune independently from slots |
| `PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH` | `4` | recursive Agent-tree depth |
| `PI_CLOUD_SUBAGENT_MAXIMUM_NODES` | `32` | total descendants per root Run |
| `PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT` | `3` | active descendants per root Run |
| `PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES` | `2` | active Cubes owned by the one-host Broker |
| `PI_CLOUD_MAXIMUM_WARM_WORKSPACE_RUNTIMES` | `4` | idle warm Cube limit |
| `PI_CLOUD_SANDBOX_WARM_TTL_MS` | `900000` | idle warm lifetime (15 minutes) |
| `PI_CLOUD_TOOL_BROKER_OWNERSHIP_LEASE_MS` | `15000` | Broker replica ownership lease |
| `PI_CLOUD_TOOL_BROKER_OWNERSHIP_HEARTBEAT_MS` | `5000` | Broker ownership heartbeat |

Worker capacity must leave room for a root Run and its configured active
children. The Worker database pool is intentionally not proportional to slots:
one connection can serve many model-waiting Runs. For Kubernetes, start near
half the slot count with a floor of four, observe pool wait time, and use a
connection proxy before multiplying connections across many replicas. Broker
heartbeat must leave more than one missed interval before lease expiry.
`production:config` rejects incoherent lease combinations.

### Streaming and Workspace operations

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_ACCEPTED_FACT_RETENTION_MS` | `7200000` | Kafka AcceptedFact retention (2 hours) |
| `PI_CLOUD_KAFKA_PARTITIONS` | `32` | Session-keyed AcceptedFact partitions |
| `PI_CLOUD_KAFKA_REPLICAS` | `3` | Kafka Topic replication factor |
| `PI_CLOUD_FACT_CHANNEL_LEASE_MS` | `9000` | short PostgreSQL ownership lease for one active logical Fact Stream |
| `PI_CLOUD_FACT_CHANNEL_MAXIMUM_ACTIVE` | `128` | bounded active logical Fact Streams per Control Plane replica |
| `PI_CLOUD_PREVIEW_ORIGIN_BASE_URL` | `http://preview.localhost:8080` | isolated application Preview base domain |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS` | `2` | trusted Volume operations in flight |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS` | `32` | bounded Volume wait queue |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS` | `30000` | maximum queue wait |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS` | `660000` | Broker-to-Volume request timeout |
| `PI_CLOUD_WORKSPACE_DELETION_REAPER_INTERVAL_MS` | `30000` | deleted-Workspace scan interval |
| `PI_CLOUD_WORKSPACE_DELETION_REAPER_BATCH_SIZE` | `16` | deletions considered per scan |
| `PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS` | empty | up to eight comma-separated RFC1918 `/24`–`/32` CIDRs that Cube guests may reach directly |
| `PI_CLOUD_CUBESANDBOX_REQUEST_TIMEOUT_MS` | `120000` | Cube lifecycle/control request timeout |

The one-host deployment assigns each combined KRaft Broker/Controller 4 CPU,
2 GiB of container memory and an explicit 1 GiB JVM heap. The remaining memory
is required for native allocations and Linux page cache; the container limit
must never be lower than `-Xmx`.

Kafka retention must cover a maximum Turn plus settlement grace. Browser
reconnect always receives a replacement PostgreSQL + Gateway-tail snapshot;
there is no public cursor or HTTP 410 replay path. Volume queue wait must be
shorter than its request timeout.

Direct private CIDRs are frozen when a Cube is created. Commands receive the
same CIDRs and their exact IP members in `NO_PROXY`, so older HTTP(S) clients
that do not understand CIDR syntax still bypass the public-only egress proxy.
Existing warm or exclusive Cubes must be recreated to
pick up a changed list. This grants guest-initiated outbound access only; it
does not expose Sandbox ports to the private network.

### Optional GitLab project connection

The default quick start requires no GitLab. To enable the project adapter,
start the optional acceptance instance with `npm run gitlab:up`, create a
project access token with Maintainer role and `api`, `read_repository`,
`write_repository` scopes, then connect the project through
`POST /v1/source-control/gitlab/projects`. This is a deployment/API operation,
not a resource-page credential form. PiCloud registers the signed project
Webhook; the Web UI only surfaces Issue tasks after they exist.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_CLOUD_GITLAB_ENABLED` | `false` | enable the GitLab provider API and Issue workflow |
| `PI_CLOUD_GITLAB_WEBHOOK_URL` | local host-gateway endpoint | URL registered on connected projects |
| `PI_CLOUD_GITLAB_INTERNAL_BASE_URL` | empty | optional trusted-plane API/Git origin for split-horizon networking |
| `PI_CLOUD_GITLAB_WORKSPACE_BASE_URL` | empty | optional Git origin reachable from Cube; defaults to the public provider origin |
| `PI_CLOUD_GITLAB_ISSUE_LABEL` | `picloud` | explicit Issue automation label |
| `PI_CLOUD_SOURCE_CONTROL_CREDENTIAL_MASTER_KEY_FILE` | generated private file | AES-GCM key for project tokens and signing tokens |

An Issue label or command only creates a pending request. An authorized PiCloud
tenant user claims it and chooses elastic compute or a directory under
`/home/user` in an owned cloud development machine. Elastic execution may
create a dedicated Workspace or reuse an existing one, and the user names the
conversation. Before a private-repository Run starts, PiCloud checks the exact
repository with `git ls-remote`. The user connects the GitLab Origin or
`https://github.com` from the conversation UI with a scoped access token. The
token is stored only in that environment's `.git-credentials`; PostgreSQL stores
no copy. The Agent performs `git clone` itself. The initial Run does not commit,
push, open a Merge Request, comment on or close the Issue.
When an internal base URL is set, Webhook identity still uses the public origin
while trusted API and Git traffic uses the internal origin. Both must identify
the same GitLab instance.

For a public deployment, replace the local Webhook URL with the public HTTPS
PiCloud endpoint. In Kubernetes enable `controlPlane.sourceControl.gitlab`, set
its Webhook URL and put the configured credential-master-key entry in
`global.existingSecret`.

### Optional GitHub App backend

Register one GitHub App for the PiCloud deployment. Configure its Setup URL as
`https://<picloud-host>/v1/source-control/github/callback` and Webhook URL as
`https://<picloud-host>/v1/source-control/github/webhook`. Grant repository
permissions `Metadata: read`, `Contents: read & write`, `Issues: read & write`
and `Pull requests: read & write`; subscribe to Issue and Issue-comment events.
Generate a private key and a high-entropy Webhook secret, then add these
restart-bound settings to the private runtime `.env`:

| Variable | Meaning |
| --- | --- |
| `PI_CLOUD_PUBLIC_ORIGIN_BASE_URL` | public PiCloud origin used in Issue/PR links |
| `PI_CLOUD_GITHUB_APP_ID` | numeric App ID |
| `PI_CLOUD_GITHUB_APP_SLUG` | App slug from its public page URL |
| `PI_CLOUD_GITHUB_APP_PRIVATE_KEY_PATH` | host path to the mode-0600 PEM file |
| `PI_CLOUD_GITHUB_WEBHOOK_SECRET_PATH` | host path to the mode-0600 Webhook-secret file |
| `PI_CLOUD_GITHUB_ISSUE_LABEL` | explicit automation label, default `picloud` |

The Compose deployment routes `api.github.com` and `github.com` through the
same bounded trusted egress relay used by model providers. In Kubernetes,
enable `controlPlane.sourceControl.github`, place the private-key and Webhook
secret entries in `global.existingSecret`, and ensure the configured provider
proxy plus NetworkPolicy allow those two hosts. The current Web resource page
does not expose this provider; installation and callback endpoints remain for
deployments that operate the GitHub adapter directly.

GitHub tokens are never valid configuration values: PiCloud mints a short-lived
installation token when needed. For an enabled unattended GitHub Issue Run, the
token is written to that Workspace's hidden Git Home and the Agent performs the
ordinary clone. Later delivery needs a fresh user-directed authorization after
the installation token expires.

### SSH and optional profiles

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_SSH_GATEWAY_ENABLED` | `true` | enable one-time-password SSH gateway |
| `PI_CLOUD_SSH_BIND_ADDRESS` | `127.0.0.1` | SSH listener |
| `PI_CLOUD_SSH_PORT` | `2222` | SSH listener port |
| `PI_CLOUD_SSH_ADVERTISED_HOST` | `127.0.0.1` | host shown to users |
| `PI_CLOUD_SSH_ADVERTISED_PORT` | `2222` | port shown to users |
| `PI_CLOUD_SSH_TICKET_TTL_MS` | `86400000` | maximum wait before an unused one-use password expires |
| `PI_CLOUD_PRODUCTION_PROFILES` | empty | set to `observability` to enable the monitoring stack |
| `PI_CLOUD_PROMETHEUS_PORT` | `9090` | loopback Prometheus UI when observability is enabled |
| `PI_CLOUD_ALERTMANAGER_PORT` | `9093` | loopback Alertmanager UI when observability is enabled |
| `PI_CLOUD_GRAFANA_PORT` | `3001` | loopback Grafana UI when observability is enabled |
| `PI_CLOUD_JAEGER_PORT` | `16686` | loopback Jaeger UI when observability is enabled |

LAN/public SSH requires host firewall, stable host-key trust and explicit bind
and advertised addresses. `127.0.0.1` never changes automatically: set the bind
address to `0.0.0.0` and the advertised host to the server's routable IP or DNS
name. The UI offers a one-line `sshpass` command and a normal `ssh` command with
the password separate. The ticket remains one-use even though its default
unused lifetime is 24 hours.

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

- `external.database`, `external.kafka` and `external.providerProxyUrl`;
- `pi-workers.services.providerGatewayUrl` and its API-key Secret entry;
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

Keep database URLs, Provider Gateway API/management keys and OAuth Volume,
Worker enrollment/management tokens,
Tool Broker token, Worker Event Ingest token, Cube API key, SSH host key and
Kafka TLS/SASL material and source-control credential master key in the
generated private files or Kubernetes Secrets. Cube receives none of them.
When GitHub integration is enabled, the App private key and Webhook secret are
also deployment Secrets; installation access tokens are generated at runtime
and must never be copied into configuration. GitLab project tokens stay
encrypted in PostgreSQL for trusted Webhook, membership and provider API work.
The separate user OAuth token is written only to the selected Workspace Git
Home, is deliberately visible to its Agent and must use the least repository
scope the workflow needs.
