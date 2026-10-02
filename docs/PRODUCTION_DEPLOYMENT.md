# One-host production deployment

The supported one-host profile requires a clean Git checkout on x86_64
Debian/Ubuntu or WSL2 with systemd, writable `/dev/kvm`, at least 16 GiB RAM and
40 GiB free disk.

```bash
./install.sh
```

The installer pins the host tools, prepares Cube/K3s and Volume Plugin,
generates private runtime secrets, builds images, migrates PostgreSQL and starts
the application. It is resumable and supports a read-only preflight:

```bash
./install.sh --check-only
```

Open `http://127.0.0.1:8080`, register the designated administrator, then run:

```bash
npm run production:administrator -- --username <registered-username>
```

Sign in again. Configure provider credentials in the linked CLIProxyAPI management
page; the PiCloud administrator page selects the platform model route, not its key.

## Upgrade

Use a maintenance window: stop new submissions, drain Runs and project all seals,
then deploy matching Control Plane, Worker, Cube runtime and Web revisions. Apply the
ordered database migrations and any required Cube plugin/template update from
that revision's deployment instructions. Reload open browser pages. Do not mix
incompatible publishers, change a live Kafka partition count or silently convert
an unsupported Volume layout. Back up user data before a storage/protocol cutover.

The current pre-release uses Kafka v13 and `pcer2_` Run references.
Migrations 160–162 and ADR-0212 add ordered control-change references on the same
physical-Session path. Drain accepted Runs, release Session leases, and publish
and project every seal on v12 before stopping old Workers and Control Plane.
Back up PG, apply the migrations from the new image, recreate its bootstrap
container, then start matching Control Plane, Workers and Web on v13. The single
Projector group bootstraps its disposable binding and pending-work views from PG.
The queue API/SSE now requires `viewVersion`; reload old browser pages. No old
consumer or wire-compatibility path runs alongside the new one. Native history,
images and Workspace Volumes remain intact. Guest build inputs and Cube Tool
wire v2 are unchanged, so this cutover preserves the running development machines
and current READY template catalog.

ADR-0209 and
migration 158 move publication from direct Worker producers to the control-plane
ingress. Drain all accepted Runs, release their Session leases and project/publish
all seals on v11 before stopping old services. Migration 158 refuses an unfinished
cutover. Start matching Control Plane and Worker binaries on the new topic and
`pi-cloud-session-projector-v2` group. There is no mixed-writer fallback or old-wire
consumer; native PG history and Cube Volume bytes remain intact. The existing
Supervisor management credential authenticates the new private publication route.
Do not expose that route through the browser gateway.

The v12 consumer reads committed transactions; ingress producer IDs are stable per
topic/partition and coupled to the current Projector group. Configure Kafka's
transaction-state replication as three and its minimum ISR as two, alongside the
existing RF3 log. A replacement ingress must initialize its fenced producer before
opening Session scopes. Rollback requires a drained matched database/code backup;
never point retired direct-producer binaries at the v12 topic.

Migration 159 and ADR-0210 complete the sandbox cutover: there is no independent
Broker deployment. Build the pinned patch set with
`node scripts/build-cubesandbox-runtime.mjs`, deploy matched Cube API/Master/
Cubelet images, and register the guest v2 template. The trusted Cubelet completion
adapter needs reachable Kafka, PG and private S3 endpoints; guest images receive
none of those credentials. The installer creates an owner-only, namespace-scoped
completion deployment kubeconfig under `runtime/cubesandbox/`. The deployment
script starts durable infrastructure, configures its Cube-side connections, then
starts Control Plane and refreshes observation routing. Existing history and
Workspace Volumes are preserved; old active execution bindings are drained.
Before replacing the old Cubelet/guest contract, use the old control plane to
release its warm elastic VMs and development machines. Their old capsules and
guest helpers cannot be adopted as v2; retained Workspace Volumes can be mounted
by newly provisioned machines. Coordinate the Cube update with every application
sharing that cluster. This repository's implementation tests do not authorize
restarting another application's shared Cube services.

The installer records the Redis credential revision on Redis and its
Master/Proxy/lifecycle consumers so their running configuration changes together.
Projected Secret updates alone do not refresh process environment or subPath
configuration. The October 1 [cutover record](reports/cube-execution-rollout-20261001.md)
records real verification of the current deployment.

`configure-cube-completion.mjs` waits for the Cubelet rollout after changing its
host credentials/configuration. EndpointSlice address refreshes alone do not
restart Cubelet. The installer requests a one-year namespace-scoped deployment
token; the API server controls its actual expiry. Rerun the root installer to
renew that private kubeconfig before it expires. Never copy a cluster-admin
kubeconfig or the completion credentials into a Tool VM.

Historical v10→v11 Tool identity and combined-intent decisions remain in ADR-0185
and ADR-0198. Current result Entry IDs remain distinct from native provider IDs;
this publication cutover does not reintroduce RunAttempt or change Tool reply IDs.

Migration 145 originally introduced v10 and requires all
accepted/queued Runs, current owners, publications and terminal Outbox rows to
drain. Stop old publishers only after their seals have projected, then migrate
and deploy matching execution services. Retire v9 only after confirming its
projection is complete. Cube Volume bytes are unchanged, but the guest Tool
envelope now uses `executionContextSha256`: rebuild/register the Cube template
and run its real operation contract check before admitting new Tools. An old
guest image is not compatible; an existing development machine must be explicitly
retired/reprovisioned rather than silently rewritten.

Migration 145 moves single-execution metadata into Run and removes Attempt/PG
slot bookkeeping. It preserves native history and closed Run evidence, and refuses
multiple historical Attempts or superseded execution history instead of silently
discarding them. Resolve such a refusal explicitly before retrying. Current
Session lease rows retain released writer-cutoff evidence; operational queries
must filter `released_at IS NULL` when they mean active ownership, not history.
Migration 146 rekeys environment-validation uniqueness to the single Run identity.
Migration 147 removes dormant accounting and environment-operation tables, not
native Pi usage/history. It requires drained Runs/current leases and refuses
nonempty historical usage/request/operation rows. Investigate such data rather
than bypassing the guard. Deploy Control Plane and Worker together: retired WS
Steer messages and unused monetary budget fields are no longer supported.
This migration does not change Kafka v10 or the current Cube guest Tool contract.

Migration 148 changes Tool dispatch/replies and removes the old operation ledger.
Drain all Runs, commit their seals and release Session leases. Stop old Workers
and Brokers before migration; deploy the matched guest template, Control Plane,
Broker and Worker images. Recreate the `database-bootstrap` service from that
same image, even if migrations were first applied with a one-off `run --rm`;
leaving an old bootstrap container can break a later Compose dependency restart.
There is no old Tool-wire fallback or automatic replay of uncertain commands.

Migration 149 replaces GitLab's old `claim_sync_pending` flag with a versioned
note-sync target and transactional invalidation triggers. Stop old Control Plane
processes before applying it, then start the matching image; old and new Issue
sync implementations must not overlap. The migration refuses an unexpired Issue
coordinator owner. Existing GitLab jobs are seeded for bounded note discovery and
verification, including jobs whose previous pending flag was clear. Native Run
and guest protocols do not change. Restore a matched database backup/code version
for rollback; there is no dual-writer or old-column compatibility path.

Migrations 150/151 introduce GPT-6 selections and immutable Session images. Drain
accepted Runs and wait for ordered closure, back up PG, then stop the old API and
Workers before migration. Roll out matching Broker, Control Plane, Worker and
guest images together. There is no rolling mixed-version image-reply contract.
Migration 150 changes future profiles only; historical Turn/Run/model records
remain unchanged. Use GPT-6 Luna for paid acceptance.

Migration 153 adopts the indexed native log (ADR-0197). Stop submissions, drain
and seal admitted Runs, then stop the old API/Projector and Workers before
migration. The migration refuses unsettled physical Sessions. It preserves
canonical log bodies, replaces Entry/Record/COW tables with log indexes and
current-operation references, and keeps live Turn deletion semantics. Deploy
matching applications and recreate `database-bootstrap` from that image; old
readers cannot run against the new schema. Kafka and guest wire formats do not
change. Verify the Guest build identity instead of rebuilding unchanged Cube
templates. A rollback requires the prior PG snapshot and matching application
revision; retain the image objects referenced by that snapshot.

Migration 154 adds scoped upload metadata and image-only user input (ADR-0200).
Drain/seal Runs, retain a private PG backup and deploy matching API, Worker,
Broker, Volume Gateway, Web and guest template builds. The fixed guest adds
`envd-input-files.mjs`; existing machines must be recreated under the current
guest contract rather than falling back to an older helper. Source images use
the existing S3 backup boundary. See [chat attachments](CHAT_ATTACHMENTS.md).

`production:init` creates private S3 credentials and `state/session-images`.
Compose provisions pinned SeaweedFS 4.47 with SQLite FULL metadata and an explicit
bucket fsync rule before applications start. Its internal filer/master/S3 ports
are not public. This single-host storage is not a replicated multi-host guarantee.
PG backups must be paired with all retained objects: copying PG alone cannot
restore image history. Export through S3 and checksum the PG reference inventory
before replacing the backend. Do not configure independent object-expiry rules.

For a component-only replacement, after draining and applying its migrations,
use Compose `up --no-deps` for the selected services when dependencies are already
healthy. An ordinary `up` may recreate changed dependencies too. If PostgreSQL
is unavailable beyond the sandbox-management ownership lease, restart Control Plane
and verify `/health/ready` before resuming Tools; an expired owner must not revive its old
authority. A live process alone is not execution readiness.

The pinned Confluent consumer uses a native addon: `dependencies:harden` and image
builds rebuild it after `npm ci --ignore-scripts`.

Guest template identity now comes from its Dockerfile/COPY build inputs (ADR-0189),
not every whole-repository commit. Registration still requires a clean checkout,
an actual image digest, READY templates and matching runtime evidence. App image
labels use the platform Git revision separately. The first cutover rebuilds the
guest catalog; later documentation/frontend-only source changes can reuse it.
`production:init` sets the owned CLIProxyAPI root `request-retry` policy to zero
without replacing credentials or provider routes; sampling retry belongs to the
Runner. Reload/restart the gateway to apply a changed local configuration.
The full deploy command recreates that gateway explicitly: a single-file bind
mount can otherwise retain the old inode after an atomic host configuration update.

Workers publish through the control-plane ingress. Control Plane's Session Projector
is the sole execution-log consumer group. Cubelet's trusted completion adapter
publishes native Tool replies to separate Worker-boot topics. Kubernetes shares
Kafka settings under `global.kafka`; allow Control Plane/Cubelet/Worker Kafka
access, Projector-to-Cube API handoff, and internal sandbox-management TCP/4300.
Each Projector advertises a unique internal URL for publication/SSE owner routing.
Workers consume their boot's replies; there is no result GET endpoint.

The safe default binds the Web/Preview entry to loopback. For a trusted LAN,
set `PI_CLOUD_HTTP_BIND_ADDRESS=0.0.0.0` in the private production environment
and access `http://<host-ip>:8080`. Internet publication should use a TLS
reverse proxy and firewall; CubeAPI, Cube WebUI and sandbox-management endpoints remain private.

The installer also creates private Workspace-terminal and SSH host credentials.
Users open the browser terminal from the Workspace panel or request a one-time
SSH password for an exclusive environment. SSH binds to `127.0.0.1:2222` by
default. Set `PI_CLOUD_SSH_BIND_ADDRESS`, `PI_CLOUD_SSH_ADVERTISED_HOST` and
`PI_CLOUD_SSH_PORT` only when the host firewall and host-key trust policy are
ready; `127.0.0.1` is not automatically replaced by a public address. Unused
tickets expire after `PI_CLOUD_SSH_TICKET_TTL_MS` (24 hours by default) and are
consumed by the first successful login. No Cube credential is exposed.

## Services

The default topology includes PostgreSQL, a three-node Kafka cluster, Control Plane, two trusted Pi
Workers, sandbox-management endpoints, persistent Workspace Volume
gateway, Cube integration, provider proxy and Web. Observability is an optional
profile. The trusted SSH gateway is enabled by
default in the one-host profile.

Temporal, Valkey, MinIO and Kopia are not installed.

## Operations

```bash
npm run production:ps
npm run production:logs
npm run production:config
npm run production:down
```

## Backup boundary

PiCloud does not provide a whole-system backup/restore command. Deployment
operators must coordinate PostgreSQL, Kafka and Cube/storage backups using their
existing infrastructure tools, preserving credentials, ownership and file modes.
PostgreSQL alone does not include an unprojected Kafka prefix or Cube VM state.
Drain execution and verify projected seals before a planned consistent snapshot;
exercise restoration on an isolated deployment before claiming recovery coverage.
Cube's node-affine VM snapshots are not automatically replicated disaster recovery.

## Acceptance

```bash
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_WORKER_POOL_CHECK=1 npm run production:worker-pool-check
PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 npm run production:control-plane-restart-check
PI_CLOUD_LIVE_LONG_CONTEXT_CHECK=1 npm run production:long-context-check
```

The first command requires explicit live-model/Cube acknowledgement and consumes
tokens. It verifies pure chat without Cube, multi-round Tool use, persistent
Volume reuse across a fresh KVM, tenant isolation and cleanup.

The long-context gate is intentionally expensive. It runs real coding tasks
until Pi compacts its native Session, verifies early-context recall and
post-compaction Tool use, and then stops the owning Worker to prove the cold
Session can be acquired and recovered by another Worker.

## Filesystem permissions

The generated runtime directory remains mode 0700. Most Secrets are 0600;
`database-url`, `workspace-volume-gateway-token` and `metrics-token` are 0640
for the trusted Volume reader. That service runs as Cube's fixed UID 1000 with
the operator's primary GID; the Volume parent is 0750. Guest files and immutable
Volume identities keep their existing ownership and private modes. These mappings
are initialized and checked by the deployment scripts, not arbitrary permission
relaxations. Do not commit runtime credentials.
