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

Sign in again and set the model provider/key in the administrator page.

The safe default binds the Web/Preview entry to loopback. For a trusted LAN,
set `PI_CLOUD_HTTP_BIND_ADDRESS=0.0.0.0` in the private production environment
and access `http://<host-ip>:8080`. Internet publication should use a TLS
reverse proxy and firewall; CubeAPI, Cube WebUI and Tool Broker remain private.

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
Workers, Tool Broker, persistent Workspace Volume
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
npm run production:backup
npm run production:restore
```

Offline backups contain PostgreSQL, the generated runtime configuration,
Worker boot ledgers and the local persistent Workspace Volume directory. On distributed
storage, use the storage backend's snapshot/backup mechanism in addition to the
PostgreSQL backup.

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

The generated runtime directory contains credentials and must remain mode 0700;
individual secrets must remain private regular files. Do not commit it.
