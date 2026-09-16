# Configuration

PiCloud has four configuration surfaces. A setting belongs to exactly one of
them:

1. the PiCloud administrator origin (local default port `8081`) for hot product settings;
2. CLIProxyAPI's native management page (local default port `8318`) for provider accounts;
3. the private one-host `.env` for restart-bound deployment settings;
4. Helm values and Kubernetes Secrets for distributed deployments.

Model keys and service credentials never belong in committed files.

## Hot administrator settings

The administrator page stores versioned values in PostgreSQL and applies them
to new requests without restarting services:

- platform-default Pi provider/model route for future conversations, without an upstream credential;
- Cube public-egress proxy URL and bypass list.

CLIProxyAPI is the only model-supply authority. Its private Volume contains
ChatGPT OAuth records and API keys; its native page manages quota, cooldown and
account health. PiCloud stores only the selected provider/model route.

New conversations use the reviewed default GPT model, medium reasoning and Fast
off. Users change this through the cascading composer menu while no Run is active.
Reviewed routes and capabilities have one code-owned source in
`packages/protocol/src/model-catalog.ts`; a new Provider still needs its adapter
and capability tests, not just a catalog entry.
Every accepted Turn freezes its own provider/model snapshot; changing the
platform default or Session default never changes historical or in-flight Runs.

DeepSeek Flash is temporarily hidden from conversation/admin selection because
its V4.1 Responses route no longer executes hosted search. DeepSeek Pro remains
listed. This is catalog visibility, not a protocol switch or model deletion:
existing Flash selections/history stay intact and can be changed explicitly.
No standalone search tool is added.

Use:

```bash
npm run production:provider-gateway:key
npm run production:provider-gateway:codex-login
npm run production:provider-gateway:deepseek-native
```

The deploy command applies the last command automatically to configured direct
DeepSeek V4 providers. Run it manually after adding such a Provider through the
CLIProxyAPI management page without redeploying the rest of PiCloud; CLIProxyAPI
hot-reloads the resulting `wire-api: responses` setting.

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

Application UID/GID are derived from private Secret ownership, not independent
identity switches. The Volume reader stays on Cube's UID 1000; see the
[filesystem permission contract](PRODUCTION_DEPLOYMENT.md#filesystem-permissions) before
changing service identities or mount permissions.

### Product and identity

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_HTTP_BIND_ADDRESS` | `127.0.0.1` | Web listener; use `0.0.0.0` only behind firewall/TLS policy |
| `PI_CLOUD_HTTP_PORT` | `8080` | Web listener port |
| `PI_CLOUD_ADMIN_BIND_ADDRESS` | `127.0.0.1` | operator-only listener bind address |
| `PI_CLOUD_ADMIN_PORT` | `8081` | PiCloud operator landing page |
| `PI_CLOUD_CLI_PROXY_MANAGEMENT_PORT` | `8318` | native Provider Gateway management page |
| `PI_CLOUD_PUBLIC_ORIGIN_BASE_URL` | `http://127.0.0.1:<HTTP_PORT>` | browser-visible product origin, also used by Preview authorization |
| `PI_CLOUD_ADMIN_ORIGIN_BASE_URL` | `http://127.0.0.1:<ADMIN_PORT>` | browser-visible administrator origin; independent from bind address/port |
| `PI_CLOUD_PROVIDER_MANAGEMENT_URL` | `http://127.0.0.1:<CLI_PROXY_MANAGEMENT_PORT>/management.html` | administrator link to the provider console |
| `PI_CLOUD_GRAFANA_URL`, `PI_CLOUD_PROMETHEUS_URL`, `PI_CLOUD_ALERTMANAGER_URL`, `PI_CLOUD_JAEGER_URL` | empty | optional browser-visible console links; empty hides the link |
| `PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID` | empty | set by `production:administrator` |
| `PI_CLOUD_PUBLIC_REGISTRATION_ENABLED` | `true` | allow new browser accounts |
| `PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS` | `1000` | maximum public tenants |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS` | `10` | projects per public tenant |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS` | `100` | Sessions per public tenant |
| `PI_CLOUD_WEB_SESSION_TTL_MS` | `2592000000` | browser login lifetime (30 days) |
| `PI_CLOUD_WEB_SESSION_COOKIE_SECURE` | `false` | set `true` when the public endpoint is HTTPS |

For LAN/HTTPS deployments, set the browser-visible origins explicitly; `0.0.0.0`
is a bind address, not a browser destination. Product/admin URLs are origins
without subpaths. Web serves this non-secret configuration at `/ui-config.json`
on page load; it is not queried per message and requires no Control Plane round
trip. Recreate Web after changing it. Authentication cookies remain host-only:
separate administrator/product hostnames require signing in on each hostname.
Vite's local demo explicitly uses one origin for both account types.

Helm uses `controlPlane.publicOriginBaseUrl`, `web.adminOriginBaseUrl`, and
`web.managementUrls`. Configure `web.ingress.host` / `adminHost` and a certificate
covering both hosts plus `*.preview.<product-host>` when enabling Ingress.
The chart routes the separate admin host to port 8081; links never infer public
addresses from Pod ports. Optional management links do not enable their services.

### Provider egress

`PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY` is the persisted HTTP(S) proxy for model
egress in the one-host deployment; empty means direct egress. Set it in the
private `.env` and recreate `provider-host-egress-relay`. The installer captures
the explicit value (or the installer's `HTTPS_PROXY`) on a fresh installation.
Later service launches do not inherit a different shell's generic proxy setting.
This is distinct from Cube guest egress and from build-time HTTP(S) proxies.
Do not commit proxy credentials or expose a local proxy publicly.

### Worker, Subagent and Sandbox capacity

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_SUPERVISOR_CAPACITY` | `4` | active physical Session families per Worker; all delegated Lanes share their family's slot |
| `PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS` | `4` | bounded PostgreSQL pool per Compose Worker; tune independently from slots |
| `PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH` | `4` | recursive Agent-tree depth |
| `PI_CLOUD_SUBAGENT_MAXIMUM_NODES` | `32` | total descendants per root Run |
| `PI_CLOUD_WORKER_MODEL_CONCURRENCY` | `4` | simultaneous provider requests across the Worker, including Compaction |
| `PI_CLOUD_SESSION_MODEL_CONCURRENCY` | `4` | simultaneous provider requests per physical Session; cannot exceed the Worker limit |
| `PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES` | `3` | active Cubes owned by the one-host Broker; leaves two elastic slots beside one starter development machine |
| `PI_CLOUD_TOOL_RESULT_CACHE_BYTES` | `67108864` | per-Broker completed response retry-cache budget (encoded bytes); native Kafka Tool Results release bodies; overflow drops oldest retry copies without re-executing effects; excludes in-flight/HTTP buffers; Helm: `sandboxPlane.toolResultCacheBytes` |
| `PI_CLOUD_TOOL_MAXIMUM_ACTIVE_COMMANDS` | `8` | simultaneous executing operations per one-host Broker (standalone/Helm default 32); distinct from physical Cube allocations |
| `PI_CLOUD_TOOL_MAXIMUM_RESULT_READERS` | `128` | HTTP result deliveries, including repeated readers of one running operation; Helm: `sandboxPlane.maximumResultReaders` |
| `PI_CLOUD_TOOL_RESULT_SENDING_BYTES` | `33554432` | encoded response bytes held until HTTP finish/close; Helm: `sandboxPlane.resultSendingBytes` |
| `PI_CLOUD_TOOL_RESULT_SEND_TIMEOUT_MS` | `30000` | stalled response send deadline, starts only after a Tool result exists; does not limit command execution |
| `PI_CLOUD_TOOL_BROKER_MEMORY_LIMIT` / `PI_CLOUD_TOOL_BROKER_CPUS` | `384m` / `1.0` | one-host Broker resources; raise together with measured operation/delivery capacity; Helm uses workload resources |
| `PI_CLOUD_MAXIMUM_WARM_WORKSPACE_RUNTIMES` | `4` | idle warm Cube limit |
| `PI_CLOUD_SANDBOX_WARM_TTL_MS` | `900000` | idle warm lifetime (15 minutes) |
| `PI_CLOUD_TOOL_BROKER_OWNERSHIP_LEASE_MS` | `15000` | Broker replica ownership lease |
| `PI_CLOUD_TOOL_BROKER_OWNERSHIP_HEARTBEAT_MS` | `5000` | Broker ownership heartbeat |

Session capacity and model concurrency are separate. Subagent depth/node settings
apply to both Projector admission and Worker bounds; Compose shares the variables,
and Helm reads the same `pi-workers.runtime.subagents` values. Model limits are
`runtime.modelConcurrency` and `runtime.sessionModelConcurrency`. Internal Worker management
RPC uses a dedicated direct connection pool, not the Provider HTTP proxy.
The Worker database pool is intentionally not proportional to slots:
one connection can serve many model-waiting Runs. Start with four per Worker,
observe pool wait time under the configured model/Lane concurrency, and use a
connection proxy before multiplying connections across many replicas. Broker
heartbeat must leave more than one missed interval before lease expiry.

The shared database adapter retains at most 128 named, parameterized SELECT
statements per physical connection. PostgreSQL may reuse their plans; query
results and parameter values are never cached. Other statements use the same
`pg` client normally. This adds neither a query retry nor a database round trip.
The bound lives in `packages/database/src/client.ts`; schema-changing deployment
still requires draining/restarting the affected processes.

Lease/startup-claim deadlines and final expiry decisions use primary PostgreSQL
time after authority locks (ADR-0170). Worker/Broker local timers use conservative
monotonic observations, not application wall clocks. There is no legacy-clock
switch. Keep the database host clock disciplined; this does not certify clock
continuity across an untested database failover.
`production:config` rejects incoherent lease combinations.

The default admits four active families, not one parent plus three children.
Models are served round-robin between ready families. Waiting for a Tool, child
or supervisor holds no model permit. Depth/node limits still bound the number
of resident tasks; capacity × (node limit + 1) must fit the 1,000-task inventory.
At 85% of the Node heap limit or reported constrained-memory RSS limit, the Worker
stops admitting new families but can finish existing families. This is a soft
admission watermark, not an OOM guarantee. Size memory for contexts, serialization
and output, not just model inference or the number of HTTP submissions.
`PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT` is removed and rejected rather than silently
interpreted as a new limit. Several Worker processes may share a host.

### Streaming and Workspace operations

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_ACCEPTED_FACT_RETENTION_MS` | `7200000` | minimum Kafka retention grace (2 hours); the reaper also requires safe PG projection progress; unprojected facts do not automatically expire |
| `PI_CLOUD_KAFKA_PARTITIONS` | `32` | Session-keyed AcceptedFact partitions |
| `PI_CLOUD_KAFKA_REPLICAS` | `3` | Kafka Topic replication factor |
| `PI_CLOUD_KAFKA_PRODUCER_PENDING_BYTES` | `67108864` | per-producer-instance encoded Fact body budget, including queued and submitted-unacknowledged Facts; Helm: `global.kafka.producerPendingBytes` |
| `PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS` | `4096` | same budget in records; limit reached rejects before enqueue; Helm: `global.kafka.producerPendingFacts` |
| `PI_CLOUD_PREVIEW_ORIGIN_BASE_URL` | `http://preview.localhost:8080` | isolated application Preview base domain |
| `PI_CLOUD_PREVIEW_PORT` | `3001` | internal Control Plane Preview listener; Compose wires Caddy to it automatically; not an application port or a new public port |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS` | `2` | trusted Volume operations in flight |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS` | `32` | bounded Volume wait queue |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS` | `30000` | maximum queue wait |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS` | `660000` | Broker-to-Volume request timeout |
| `PI_CLOUD_WORKSPACE_DELETION_REAPER_INTERVAL_MS` | `30000` | deleted-Workspace scan interval |
| `PI_CLOUD_WORKSPACE_DELETION_REAPER_BATCH_SIZE` | `16` | deletions considered per scan |
| `PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS` | empty | up to eight comma-separated RFC1918 `/24`–`/32` CIDRs that Cube guests may reach directly |
| `PI_CLOUD_CUBESANDBOX_REQUEST_TIMEOUT_MS` | `120000` | Cube lifecycle/control request timeout |

Worker and Projector use the same Kafka settings. Helm stores these once under
`global.kafka`, inherited by the Worker subchart. Each Control Plane/Projector
advertises a unique internal URL through `PI_CLOUD_PROJECTOR_ADVERTISED_URL`;
Kubernetes derives it from Pod IP and HTTP port. Browsers use the public endpoint,
not these URLs. Projector runs in Control Plane; the independent event-projector
profile and per-token Fact channel settings are removed.

Producer budgets are loaded once into each service's startup configuration; the
local Kubernetes cutover carries the same `.env` limits into its Worker values.
Retention grace belongs only to the Projector's safe reaper, not the Producer:
changing it does not enable Kafka's automatic age/size deletion.

Bash has a code-owned 0.1–300-second execution range, default 300 seconds when
omitted. Out-of-range values are rejected instead of silently clamped. This is
distinct from the longer transport timeout and the Run deadline; long-lived
services should detach their standard streams and be checked in a later Tool call.

The code-owned SSE v2 transport limits each frame to 128 KiB; JSON parts contain
at most 16,384 UTF-16 code units so escaping also fits. This is not a 128 KiB
conversation limit. A blocked socket write times out after 30 seconds and closes
only that viewer. Snapshots initially include 40 Turns, with older history loaded
by Turn identity. No extra timer is added before normal text delivery.

The installer owns `PI_CLOUD_CUBESANDBOX_TEMPLATE_ID` and the mandatory
`PI_CLOUD_CUBESANDBOX_DEVELOPMENT_TEMPLATE_IDS` JSON map. The latter contains
distinct `starter`, `standard` and `performance` template IDs generated from
the current immutable template registry. Distributed Helm deployments provide
the same three IDs through `sandboxPlane.cube.developmentTemplateIds`; a
missing profile never silently falls back to the ordinary Tool template.

The one-host deployment assigns each combined KRaft Broker/Controller 4 CPU,
2 GiB of container memory and an explicit 1 GiB JVM heap. The remaining memory
is required for native allocations and Linux page cache; the container limit
must never be lower than `-Xmx`.

One Projector group consumes the execution log, using partition pause/seek, a
32 MiB native queue and a 5 ms fetch-queue backoff. Tool Broker has no Kafka
connection. Result readers, active commands and response bytes retain their
separate limits. Command arrival wait is 30 seconds; after admission the Tool
deadline applies, followed by a send deadline only once the result exists.

`PI_CLOUD_TOOL_DISPATCH_TOKEN_FILE` points to `tool-dispatch-token`, shared by
Projectors and executors, never Workers or Cube. Internal TCP/4300 must be
reachable. Native result/seal notices retire raw-result copies. A five-second
delivery timeout retries the same positioned record while its owner is live;
a vanished boot does not cause execution on another machine. The seal Outbox
polls every 50 ms. There is no second Kafka commit-notification round trip.

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
tenant user claims it and chooses elastic compute or an existing absolute
directory in an owned cloud development machine. Elastic execution may
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

GitHub App onboarding is unavailable: the installation-link and setup-callback
endpoints have been removed (ADR-0169). PiCloud login does not prove GitHub
installation access. Ordinary environment-local GitHub credentials and Git clone
remain available, and GitLab Issue integration is unchanged.

The optional App backend serves **already-bound** integrations only. Its Webhook
URL is `https://<picloud-host>/v1/source-control/github/webhook`. These restart-bound
settings preserve their repository refresh and Issue intake:

| Variable | Meaning |
| --- | --- |
| `PI_CLOUD_PUBLIC_ORIGIN_BASE_URL` | public PiCloud origin used in Issue/PR links |
| `PI_CLOUD_GITHUB_APP_ID` | numeric App ID |
| `PI_CLOUD_GITHUB_APP_PRIVATE_KEY_PATH` | host path to the mode-0600 PEM file |
| `PI_CLOUD_GITHUB_WEBHOOK_SECRET_PATH` | host path to the mode-0600 Webhook-secret file |
| `PI_CLOUD_GITHUB_ISSUE_LABEL` | explicit automation label, default `picloud` |

The Compose deployment routes `api.github.com` and `github.com` through the
same bounded trusted egress relay used by model providers. In Kubernetes,
enable `controlPlane.sourceControl.github`, place the private-key and Webhook
secret entries in `global.existingSecret`, and ensure the configured provider
proxy plus NetworkPolicy allow those two hosts. This does not enable new App
installation bindings. App discovery tokens are transient; user Git authorization
is a separate environment-local credential and is not supplied by the App backend.

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
model upstream connect 120 s <= Pi response-header wait 150 s <= Pi Turn 600 s
model upstream stream idle 300 s <= Pi Turn 600 s
Tool Broker request 360 s
model capability TTL 900 s
Worker termination grace 1320 s
Workspace Volume request 660 s < Volume gateway termination grace 720 s
```

Changing these requires editing the deployment policy and running
`npm run runtime-policy:check`; do not change only one container variable.

## Distributed Helm values

The distributed chart uses `values.yaml` for non-secret topology and a named
Kubernetes Secret for credentials. Important value groups are:

- `external.database`, `global.kafka` and `external.providerProxyUrl`;
- `pi-workers.services.providerGatewayUrl` and its API-key Secret entry;
- `sandboxPlane` for Cube, Workspace storage and Broker/Volume capacity;
- `pi-workers.workerPool`, `autoscaling`, `runtime` and `lifecycle`;
- `networkPolicy.externalEgressCidrs`;
- `images` and `global.imageRevision`.

The database URL may use PgBouncer transaction pooling with protocol-level
prepared-statement tracking enabled (`max_prepared_statements > 0`, PgBouncer
1.21 or newer; start with 128). Do not use SQL-level PREPARE/EXECUTE wrappers.
See [PgBouncer's configuration contract](https://www.pgbouncer.org/config.html#max_prepared_statements).
The separate
notification URL must connect directly to PostgreSQL because `LISTEN` is
session-scoped. The Volume Gateway also mounts this direct Secret key for its
session-scoped advisory locks; transaction-pooling endpoints must not be used
there. Its dedicated lock pool discards a connection if cleanup is uncertain.
Workspace storage must support ReadWriteMany for replicated
Volume gateways.

## Validate changes

```bash
npm run production:config
npm run runtime-policy:check
npm run helm:check
```

Service startup validates individual ranges; the Compose wrapper additionally
validates cross-service concurrency, lease, retention and timeout relations.

Producer limits include queued and submitted-unacknowledged encoded Fact bodies,
not process RSS or all upstream objects. Capacity overflow rejects before enqueue;
it can fail the current Run but never acknowledges missing data. Per-lane `drain`
adds no fixed batching delay. The 10-second Producer close budget fits inside the
process shutdown grace and reports failure if admitted data cannot drain.
Broker limits must leave headroom for V8 objects, request decoding, native buffers
and lightweight operation metadata. They are not tenant quotas or Workspace locks.

## Secrets

Keep database URLs, Provider Gateway API/management keys and OAuth Volume,
Worker enrollment/management tokens,
Tool Broker service/dispatch tokens, Cube API key, SSH host key and
source-control credential master key in the
generated private files or Kubernetes Secrets. Cube receives none of them.
When GitHub integration is enabled, the App private key and Webhook secret are
also deployment Secrets; installation access tokens are generated at runtime
and must never be copied into configuration. GitLab project tokens stay
encrypted in PostgreSQL for trusted Webhook, membership and provider API work.
The separate user access token is written only to the selected environment's
Git credential file, is deliberately visible to its Agent and must use the least repository
scope the workflow needs.

Kafka currently uses private-network plaintext connections. The chart does not
wire TLS/SASL credentials into the runtime; placing them in a Secret does not
enable authenticated Kafka. Keep those listeners restricted to trusted services.
