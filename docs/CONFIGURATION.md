# Configuration

ADR-0269 adds `controlPlane.enabledControlTools` to the platform Helm chart for
ordinary trusted control tools. `null` (default) advertises every registered
implementation; `[]` withdraws all ordinary tools; `["preview"]` selects preview.
The rendered `PI_CLOUD_CONTROL_TOOLS_ENABLED` is a JSON name array. Unknown names
fail startup. This selects installed handlers and never loads executable plugins
or changes fixed Pi file/shell grants and native coordination adapters.
Changes take effect after a compatible Control Plane restart and Worker catalog
delivery; an existing Agent loop sees them on its next prepared model request.
See [ADR-0269](adr/0269-execution-owned-control-tool-catalog.md) and the
[delivery record](reports/runtime-capabilities-delivery-20261021.md) for current
source/rollout status. The initial schema 197/protocol upgrade remains matched.

Pending conversation inputs have no count quota. Their existing 100,000-character
wire envelope remains bounded, along with encoded delegated startup records. The pending-input view uses
`input.queue` SSE updates and current snapshots on initialization, reconnect and
focus; browser requests have a ten-second deadline. Successful actions reuse
their returned snapshot. Promotion reconciliation wakes affected Sessions on
changes/known deadlines and selects at most 32 eligible rows per scoped pass;
it allows two local HTTP deliveries in flight and retains per-Run delivery order.
Retries use the existing control-request identity and bounded next-attempt times.
Delivery batch sizes and transport envelopes do not cap the total accepted queue. See [ADR-0194](adr/0194-editable-pending-inputs.md) and
[ADR-0212](adr/0212-ordered-control-read-models.md).

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

New conversations use the default model and reasoning declared by the reviewed
catalog, with Fast off. Users change selections through the composer while no Run
is active. The seed is `deploy/helm/pi-cloud-platform/files/model-catalog.json`;
Helm's `modelCatalogJson` can supply a complete deployment override. The Control
Plane reads `PI_CLOUD_MODEL_CATALOG_FILE` (mounted at
`/run/pi-cloud-models/model-catalog.json`), validates the whole document and keeps
one in-memory view. [Independent catalog publication](COMPONENT_RELEASE.md) waits
for serving instances to acknowledge its digest. A new provider protocol still
needs its adapter and tests. Existing tenant settings are not rewritten.

`GET /v1/models` supplies `revision`, `defaultModel`, `reloadFailed` and `models`.
`defaultModel` is the new-chat default; entry `default` flags retain the tenant's
configured route. Client schemas validate model ID syntax; Control Plane checks
actual availability and reasoning against the loaded catalog. There is no client
or Worker model-name enumeration. An invalid reload retains the last good catalog;
invalid startup fails. Refresh open pages to fetch new choices.

Every accepted Run stores complete runtime capabilities and the catalog digest
in `model_runtime_snapshot`. Worker claim/recovery and native children reuse it;
active follow-up image validation does too. Default/catalog changes never rewrite
accepted work or history, and add no per-model-request SQL. Withdrawn selections
remain readable/editable but cannot admit new work. Existing profile restrictions
and explicit desired settings remain in force; retain upstream routes needed by
already accepted work.

DeepSeek V4.1 Flash is selectable; V4 Pro is hidden from conversation/admin
selection at the owner's request. Flash keeps `hostedTools: ["web_search"]` on
Responses: the upstream currently accepts but ignores that declaration, so it
does not establish working search. Only real provider search events/results are
shown. Existing model identities and history remain readable; no automatic
Pro-to-Flash alias or alternate search backend is introduced.

Use:

```bash
npm run production:provider-gateway:key
npm run production:provider-gateway:codex-login
npm run production:provider-gateway:deepseek-native
```

The deploy command applies the last command automatically to configured direct
DeepSeek V4 providers. It writes `wire-api: responses` and the reviewed reasoning
capabilities, including `none` and `max`; CLIProxyAPI's generic compatibility
defaults otherwise convert off to low. The levels come from the same model catalog
as the UI. This changes neither provider credentials nor unrelated models.

When running this file-based setup command manually after adding a Provider,
wait for active model Runs to finish and restart **only** `cli-proxy-api` through
`node scripts/production-kubernetes.mjs restart cli-proxy-api`. The one-host config
is a single-file bind mount: host-side atomic replacement is not an in-container
hot edit. Normal account changes through CLIProxyAPI's own management page remain
its native hot-reload path; no cluster restart is required.

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
| `--skip-host-bootstrap` | off | require preinstalled host dependencies |

Existing bind/port/Worker mode is never silently overwritten. Use
`./install.sh --print-plan` or `./install.sh --check-only` before changing a
host.

Locally imported application and infrastructure images are marked
`io.cri-containerd.pinned=pinned`, so Kubelet image GC cannot remove the release
while it is waiting for rollout or scaled to zero. This is the CRI's standard
[image pinning behavior](https://github.com/containerd/containerd/discussions/12156).
Remove the pin from retired release tags only after confirming that neither the
current desired deployment nor the retained rollback needs them. Imported base
Pod images (such as K3s's configured `pause` image) also need their system-image pin;
a missing base image can prevent every new Pod from starting even when the
application image is present.

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
| `PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS` | `unlimited` | maximum public tenants |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS` | `unlimited` | projects per public tenant |
| `PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS` | `unlimited` | Sessions per public tenant |
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

For a one-host deployment with a shared upstream proxy, set it once with:

```sh
npm run production:proxy -- http://127.0.0.1:12450
```

The private `deploy/production/runtime/upstream-proxy` file records the address.
Omit the argument to reapply it. The command synchronizes Docker/K3s, the model host
Relay through Helm, and Cube's existing PG settings. Cube's enabled/disabled
choice is retained. Docker requires host administration and idle build/test
containers. K3s uses a normal service restart when its environment changes;
its workload containers keep running. On WSL it uses
the distribution's normal root invocation; other Linux hosts use `sudo -n`.
Partial failures identify the unfinished phase; rerun the same command to finish.

Build/release entry points automatically load this address. For an existing host
Bash session, use `source scripts/use-upstream-proxy.sh`; this helper can also be
sourced from the user's shell profile. Proxy aliases are refreshed together.

`PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY` in the private `.env` remains the provider
deployment input; empty means direct egress. The installer captures it (or the
installer's `HTTPS_PROXY`) on a fresh installation. Separate provider/Cube proxy
configuration remains supported; the shared command is an explicit synchronization
operation under [ADR-0271](adr/0271-local-upstream-proxy-configuration.md).
Do not commit proxy credentials or expose a local proxy publicly.

### Worker, Subagent and Sandbox capacity

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_SUPERVISOR_CAPACITY` | `unlimited` | active physical Session families per Worker; all delegated Lanes share their family's slot |
| `PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS` | `4` | bounded PostgreSQL pool per Worker; tune independently from slots |
| `PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH` | `unlimited` | recursive Agent-tree depth |
| `PI_CLOUD_SUBAGENT_MAXIMUM_NODES` | `unlimited` | total descendants per root Run |
| `PI_CLOUD_WORKER_MODEL_CONCURRENCY` | `unlimited` | simultaneous provider requests across the Worker, including Compaction |
| `PI_CLOUD_SESSION_MODEL_CONCURRENCY` | `unlimited` | simultaneous provider requests per physical Session; combines with any explicitly configured Worker limit |
| `PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES` | `unlimited` | optional active-Cube quota; physical Cube capacity still applies |
| `PI_CLOUD_RUNTIME_PROBE_CONCURRENCY` | `4` | concurrent physical-runtime health checks per control plane, range 1–64; limits in-flight work, never the number of VMs covered |
| `PI_CLOUD_TOOL_MAXIMUM_ACTIVE_COMMANDS` | `8` | simultaneous interactive workflows per control plane (Helm default 32); fixed Tools have a Cubelet-local limit of 32 |
| `PI_CLOUD_ELASTIC_RETENTION_MS` | `900000` | finite elastic-VM retention window, captured in the allocation before creation; Cubelet owns expiry, range 1 second–24 hours |
| `PI_CLOUD_SANDBOX_CONTROL_OWNERSHIP_LEASE_MS` | `15000` | control-plane sandbox-management ownership lease |
| `PI_CLOUD_SANDBOX_CONTROL_OWNERSHIP_HEARTBEAT_MS` | `5000` | sandbox-management ownership heartbeat |

[ADR-0272](adr/0272-cube-owned-elastic-retention.md) uses 15-second active-Session
keepalives and 30-second per-VM coalescing. Initial renewal need not wait for the
first interval. The window is immutable for an existing allocation; a deployment
setting change applies to newly created VMs. There is no controller warm-count
eviction or idle-deadline timer. Capacity admission still waits for confirmed
physical release. Dedicated machines do not use the finite window; background
health checks do not renew it. Conversation data and Workspace Volumes survive
elastic compute expiry.

The self-hosted K3s kubelet uses `pod-max-pids=-1` (node allocatable PID capacity).
Helm workloads keep scheduling requests and omit CPU/memory hard limits; scratch
`emptyDir` volumes have no PiCloud size ceiling. VM profile specifications still
allocate finite guest CPU/memory. There is no PiCloud `GOMEMLIMIT` override.

Product quotas default to absent (`null` in durable policy and Helm values,
`unlimited` in environment configuration). This includes tenants/projects/Sessions,
Worker families, model concurrency, model/Tool counts per Run and Subagent trees.
Explicit positive limits remain optional operator policy; migrations 166–168 clear
the previous deployment defaults. See [ADR-0215](adr/0215-unlimited-product-quotas.md).

Session capacity and model concurrency are separate. Subagent depth/node settings
apply to both Projector admission and Worker bounds; the self-hosted values generator shares the variables,
and Helm reads the same `pi-workers.runtime.subagents` values. Model limits are
`runtime.modelConcurrency` and `runtime.sessionModelConcurrency`. Internal Worker management
RPC uses a dedicated direct connection pool, not the Provider HTTP proxy.
The Worker database pool is intentionally not proportional to slots:
one connection can serve many model-waiting Runs. Start with four per Worker,
observe pool wait time under the configured model/Lane concurrency, and use a
connection proxy before multiplying connections across many replicas. Sandbox-management
heartbeat must leave more than one missed interval before lease expiry.

The Worker lease adapter uses an additional two-connection PG pool on the existing
direct notification URL (without LISTEN). It must reach the same authority database
with permission to read/renew leases and quarantine its Worker; a LISTEN-only role
is insufficient. This avoids routing authority cleanup through PgBouncer.
[ADR-0258](adr/0258-bounded-session-lease-renewal.md) fixes acquisition and complete
checkout budgets at five seconds each, including renewal COMMIT. These isolate
lease I/O from history/claim work and are not product quotas.

Control Plane short expiry/retirement-admission operations use a separate
three-connection pool on that same direct notification URL, with five-second
acquisition and checkout budgets (ADR-0259). Session, connection and failed-Worker
scans each process up to 100 candidates per iteration and rotate past busy rows.
These are maintenance work budgets; they do not limit the number of Sessions or
Workers. Remote stop/inventory keeps its existing request/claim limits.

The shared database adapter retains at most 128 named, parameterized SELECT/WITH
statements per physical connection and keeps up to two already-created connections
warm within each pool's existing maximum. Excess connections still retire after
10 seconds idle; connections are never preallocated per Run or Session. This
avoids losing prepared plans on every user/model pause. It retains
no result cache: PostgreSQL may reuse plans, while query
results and parameter values are never cached. Other statements use the same
`pg` client normally. This adds neither a query retry nor a database round trip.
The bound lives in `packages/database/src/client.ts`; schema-changing deployment
still requires draining/restarting the affected processes.

Session lease deadlines and final expiry decisions use primary PostgreSQL
time after authority locks (ADR-0170). Worker/control-plane local timers use conservative
monotonic observations, not application wall clocks. There is no legacy-clock
switch. Keep the database host clock disciplined; this does not certify clock
continuity across an untested database failover.
`production:config` rejects incoherent lease combinations.

There is no default active-family or child-count quota. With explicit finite
model permits, ready families are served round-robin. Waiting for a Tool, child
or supervisor holds no model permit. Memory admission stops new families at 85%
heap/constrained-memory RSS use or below 15% available host/cgroup memory, while
existing families can finish. This is a soft admission watermark, not an OOM
guarantee. Contexts and serialization still consume real memory.
The OS memory limit is sampled once a second on one internal thread per Worker;
heap usage and RSS remain fresh main-thread reads. Missing, failed or older-than-2.5s
limit samples stop new-family admission. This prevents synchronous cgroup discovery
from blocking Agent/SQL callbacks; it adds no Agent slot or distributed authority.
`PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT` is removed and rejected rather than silently
interpreted as a new limit. Several Worker processes may share a host.

### Streaming and Workspace operations

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_CLOUD_ACCEPTED_FACT_RETENTION_MS` | `7200000` | minimum Kafka retention grace (2 hours); the reaper also requires safe PG projection progress; unprojected facts do not automatically expire |
| `PI_CLOUD_KAFKA_PARTITIONS` | `32` | Session-keyed AcceptedFact partitions |
| `PI_CLOUD_KAFKA_REPLICAS` | `3` | Kafka Topic replication factor |
| `PI_CLOUD_KAFKA_PRODUCER_PENDING_BYTES` | `67108864` | encoded Fact body budget, including queued and submitted-unacknowledged Facts; shared by all Session writers in one Worker process, with a separate control-publication budget per Control Plane process; Helm: `global.kafka.producerPendingBytes` |
| `PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS` | `4096` | same budget in records; limit reached rejects before enqueue; Helm: `global.kafka.producerPendingFacts` |
| `PI_CLOUD_PREVIEW_ORIGIN_BASE_URL` | `http://preview.localhost:8080` | isolated application Preview base domain |
| `PI_CLOUD_PREVIEW_PORT` | `3001` | internal Control Plane Preview listener; the Helm chart wires Caddy to it automatically; not an application port or a new public port |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS` | `2` | trusted Volume operations in flight |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS` | `32` | bounded Volume wait queue |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS` | `30000` | maximum queue wait |
| `PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS` | `660000` | Control-plane-to-Volume request timeout |
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
32 MiB native queue and a 5 ms fetch-queue backoff. The trusted Cube completion adapter publishes native
Tool replies to a separate Worker-boot Kafka topic; it does not consume the
execution log. The reply producer caps in-flight bytes at 16 MiB and delivery
at 30 seconds. Replies expire after 11 minutes; positively retired boot topics
and groups are reaped after that grace. Active commands remain separately bounded.
Only final Tool results and bounded typed execution-probe replies use that topic.
Probe replies never become Tool Results or native history. Temporary progress uses the completion adapter's
`PI_CLOUD_CONTROL_PLANE_URL` (the internal Control Plane Service URL), the existing
Supervisor management credential and TCP/3000. Helm supplies it. HTTP connections are
pooled; snapshots are bounded to 8,192 characters with a one-second send cadence
and one-second deadline. Progress failure never changes execution status.

Fixed Tools are handed directly from Projector to the recorded Cube API/node/boot.
The native handoff is bounded to five seconds; ambiguous acceptance closes that
operation scope and is not replayed. Closure blocks publication admission, joins
Cube/workflow scopes, then publishes the ordered seal. The shared seal/control
Outbox uses LISTEN hints, known retry deadlines and a one-second idle fallback.
Its 16 send slots progress independently; cleanup drains bounded batches separately. Interactive workflows use
the private control-plane TCP/4300 endpoint and
the Supervisor management credential. There is no completed-result GET/cache or
commit-notification RPC.

Worker Run admission refreshes the private publication partition mask every second;
success expires after three seconds even if a later request hangs. Projector peer
readiness is coalesced, cached for 500 ms and intersected with group ownership
(cached up to one second). Local health does not recursively query peers.
Binding bootstrap pages contain at most 256 rows, filtered by owned partitions;
retained views are capped at 65,536 entries and 64 MiB serialized metadata per owner.

Every Projector needs credentials for all Cube API endpoints it may route to.
`PI_CLOUD_CUBE_EXECUTION_ENDPOINTS_FILE` is an optional private JSON array of
`{ "apiUrl": "https://cube.example", "apiKeyFile": "/run/secrets/cube-key" }`;
the primary configured Cube endpoint is included automatically. Helm exposes
`sandboxPlane.cube.executionEndpoints` with corresponding Secret keys. An unknown
endpoint is rejected before sending credentials; dispatch never falls back to
another cluster. Self-hosted installation builds the pinned Cube patch set and
mounts completion PG/S3/management credentials only into the trusted Cubelet.

Kafka retention must cover a maximum Turn plus settlement grace. Browser
reconnect always receives a replacement PostgreSQL + Gateway-tail snapshot;
there is no public cursor or HTTP 410 replay path. Volume queue wait must be
shorter than its request timeout.

SSE subscriptions have code-owned guards of 1,024 pending formal events and
16 MiB of encoded event bytes (ADR-0257). Counting is shared for each broadcast
and skipped when no reader needs to queue the event. Overflow uses replacement
snapshots. These protect disposable per-connection backlog; they do not cap
conversation output, total snapshot size or process heap. The current in-flight
value and the existing 30-second blocked-write deadline are separate boundaries.

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

The self-hosted deployment routes `api.github.com` and `github.com` through the
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

The maintained source fixes Tool, model-request and shutdown budgets as a
validated set. They are not ordinary `.env` knobs because increasing one may
make another service kill a still-valid operation. Under ADR-0263 there is no
overall Agent/Run duration limit or independent model-capability TTL. Source defaults are:

```text
model upstream connect 120 s <= Pi response-header wait 150 s
model upstream stream idle 300 s
Sandbox management/workflow request 360 s; fixed Tool handoff 5 s
Worker natural-drain grace 30 s; retirement/settlement bound 660 s
process cleanup hard bound: 30 + 660 + 60 = 750 s
Worker termination grace 1320 s
Workspace Volume request 660 s < Volume gateway termination grace 720 s
```

Changing these requires editing the deployment policy and running
`npm run runtime-policy:check`; do not change only one container variable.
`PI_CLOUD_PI_TURN_TIMEOUT_MS` and `PI_CLOUD_MODEL_GATEWAY_CAPABILITY_TTL_MS` are
removed and rejected. Model grants are revoked on work closure, Stop, ownership
loss or boot retirement. Worker shutdown closes claims and uses existing ordered
recovery after its drain grace; it does not wait forever for Agent completion.
The [delivery record](reports/model-runtime-repair-20261020.md) distinguishes
source implementation from the serving release during this matched cutover.

## Distributed Helm values

The distributed chart uses `values.yaml` for non-secret topology and a named
Kubernetes Secret for credentials. Important value groups are:

- `external.database`, `global.kafka` and `external.providerProxyUrl`;
- `pi-workers.services.providerGatewayUrl` and its API-key Secret entry;
- `sandboxPlane` for Cube, Workspace storage and sandbox-management/Volume capacity;
- `pi-workers.workerPool`, `autoscaling`, `runtime` and `lifecycle`;
- `networkPolicy.externalEgressCidrs`;
- `images` and `global.imageRevision`.

`global.imageRevision` / `PI_CLOUD_IMAGE_REVISION` identifies the guest build inputs
(40 hex characters), matching the selected Cube template evidence. Application
image labels use the separate Git code revision. The registration command computes
the guest identity; do not substitute the current platform commit for an unchanged
guest catalog. See ADR-0189 and the production upgrade instructions.

The database URL may use PgBouncer transaction pooling with protocol-level
prepared-statement tracking enabled (`max_prepared_statements > 0`, PgBouncer
1.21 or newer; start with 128). Do not use SQL-level PREPARE/EXECUTE wrappers.
See [PgBouncer's configuration contract](https://www.pgbouncer.org/config.html#max_prepared_statements).
The dedicated queue-display pool sends a five-second `statement_timeout` startup
parameter. A PgBouncer query endpoint must track that parameter as well
(`track_extra_parameters = statement_timeout`) rather than ignore it; verify this
support on the deployed PgBouncer version. The repair acceptance uses direct PG.
See [startup parameter tracking](https://www.pgbouncer.org/config.html#track_extra_parameters).
The separate
notification URL must connect directly to PostgreSQL because `LISTEN` is
session-scoped. Control Plane and Worker both read `DATABASE_NOTIFICATION_URL_FILE`;
when absent, they use `DATABASE_URL_FILE` (appropriate for direct-PG self-hosting).
Helm mounts `external.database.notificationSecretKey` for the Control Plane's
one terminal-relay listener per replica, outside its ordinary SQL pool. It does
not allocate a listener per Session. The Volume Gateway uses the ordinary database
Secret key for upload authorization. File exclusion uses util-linux `flock` on
the shared Volume, held by its filesystem callback, independently of PG connections
(ADR-0231/0234). Browsing/uploads share Volume access; credential callbacks use a
narrow exclusive lock and deletion requires exclusive Volume access.
Replicated gateways require ReadWriteMany storage with cross-client
locking; NFS local-only locking and mtime-based stale-lock recovery are unsupported.
The chart uses `Recreate` for Gateway upgrades so different lock contracts never
overlap. Validate locking on the actual storage backend before multi-node deployment.

## Validate changes

```bash
npm run production:config
npm run runtime-policy:check
npm run helm:check
```

Service startup validates individual ranges; the Kubernetes deployer additionally
validates cross-service concurrency, lease, retention and timeout relations.

Producer limits include queued and submitted-unacknowledged encoded Fact bodies,
not process RSS or all upstream objects. Capacity overflow rejects before enqueue;
it can fail the current Run but never acknowledges missing data. Per-lane `drain`
adds no fixed batching delay. The 10-second Producer close budget fits inside the
process shutdown grace and reports failure if admitted data cannot drain.
Control-plane and Cubelet limits must leave headroom for V8 objects, request decoding, native buffers
and lightweight operation metadata. They are not tenant quotas or Workspace locks.

## Secrets

Keep database URLs, Provider Gateway API/management keys and OAuth Volume,
Worker enrollment/management tokens,
Sandbox management service tokens, Cube API key, SSH host key and
source-control credential master key in the
generated private files or Kubernetes Secrets. The Tool guest receives none of them;
the trusted Cubelet completion adapter receives only its PG/S3/management credentials.
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

## Session image attachments

Trusted Control Plane, Cube completion adapter and Workers use the same private S3 bucket:

| Setting | Meaning |
| --- | --- |
| `PI_CLOUD_IMAGE_S3_ENDPOINT` | Private S3 endpoint; no guest/browser access |
| `PI_CLOUD_IMAGE_S3_REGION` | Signing region, default `us-east-1` |
| `PI_CLOUD_IMAGE_S3_BUCKET` | Exclusive attachment bucket, default `pi-cloud-session-images` |
| `PI_CLOUD_IMAGE_S3_CREDENTIALS_FILE` | Private JSON containing `accessKeyId` and `secretAccessKey` |

The self-hosted deployment initializes these automatically. Helm exposes `imageAttachments` with
`endpoint`, `region`, `bucket` and `credentialsSecretKey`; configure the same
backend in the platform and `pi-workers` values, and put the JSON in each trusted
component's existing Secret. An empty endpoint disables image storage explicitly;
reading images then fails clearly instead of returning inline Kafka payloads.

Uploads and image references have no product byte quota; guest normalized-image
reply envelopes remain 64 MiB. S3 upload transport streams. Native buffered image
reads/writes wait under a 128 MiB aggregate admission budget; an oversized single
image may proceed alone. This is transport backpressure, independent of native
context memory. Model requests permit 128 MiB raw/decompressed bodies with a
256 MiB aggregate in-flight payload budget; buffers and parsed JSON add memory
beyond these byte counters. Kafka execution records stay below 900 KiB and reject
oversized individual publications before entering the bounded control-plane ingress.
Orphan inventory is eligible after 24 hours and source Run closure; retained
native history pins attachments through Compaction, Fork and Lane pruning.

New conversations default to GPT-6 Sol. GPT-6 Luna is the paid-test model; Astra
is an explicit higher-cost choice and does not offer disabled reasoning.
DeepSeek Flash uses the Responses route with text/image input and an owner-approved
search declaration. September 26 probes confirm image input and an accepted search
parameter, but no actual Responses search. The separate Anthropic-route search
probe succeeded; this deployment retains Responses.
