# Self-hosted K3s deployment

The supported one-host profile runs **all PiCloud services in the existing K3s
cluster**, alongside CubeSandbox. Docker builds and imports images; it does not
run the platform. See [ADR-0214](adr/0214-unified-self-hosted-k3s.md).

Requires x86_64 Debian/Ubuntu or WSL2 with systemd, writable `/dev/kvm`, at least
16 GiB RAM and 40 GiB free disk. This is a private, single-node deployment, not
machine-level HA. Three Kafka processes preserve the application RF3/ISR2 contract
but share one failure domain. K3s's own datastore is independent of PiCloud PG.

```bash
./install.sh --check-only
./install.sh
```

The installer pins host tools and Cube, creates private configuration, prepares
local volumes, builds/imports images and installs two Helm releases in
`cube-system`: `pi-cloud-infrastructure` followed by `pi-cloud`. The second release
runs a database migration/bootstrap Job before application rollout. Worker boot
claims use the K3s local-path provisioner; its helper image is prefetched too.
Workers retain the former 2 GiB memory limit for large native image payloads;
1 GiB failed the 25 MB image acceptance. The provider gateway uses 1 GiB with
`GOMEMLIMIT=768MiB`: its former 512 MiB limit also failed the multi-image request
on K3s without container swap. This is a measured local-profile budget, not a
guarantee for arbitrary concurrent large-context requests. The kubelet permits 1,024 tasks per Pod because the Control Plane's partitioned
Kafka producers require native threads; a 128-task limit prevents ingress readiness.

Open `http://127.0.0.1:8080`, register an account, then designate the administrator:

```bash
npm run production:administrator -- --username <registered-username>
```

Sign in again. The administrator page is `http://127.0.0.1:8081`; provider
management is `http://127.0.0.1:8318/management.html`. Configure provider credentials
there and choose the platform model route in PiCloud. SSH defaults to local port
2222. Public Web binding and admin binding are separate; changing the former must
not expose management endpoints. See [configuration](CONFIGURATION.md).

## Deployment and operations

```bash
npm run production:config                    # validate/render private manifests
npm run production:build                     # build matching application images
node scripts/production-kubernetes.mjs import-images
npm run production:up                        # reconcile both Helm releases
npm run production:ps
npm run production:logs -- control-plane
node scripts/production-kubernetes.mjs logs pi-workers
node scripts/production-kubernetes.mjs restart web
```

`npm run production:deploy` also initializes configuration, registers the matching
Cube guest template, builds/imports application images and deploys. It does not
implicitly rebuild the Cube host protocol. For a changed Cube patch set, use the
matched Cube build/install instructions before platform rollout.

The operator kubeconfig is `deploy/production/runtime/k3s/kubeconfig.yaml`, mode
0600. It has cluster administration privileges and is never mounted into a Worker
or guest. On WSL, use the Linux `/usr/local/bin/k3s kubectl` binary; a Windows
`kubectl.exe` wrapper can reach a different localhost and report misleading CA errors.
Application Pods do not mount service-account tokens.

Applications address `postgres`, `kafka-1..3`, `session-images`, `control-plane`,
`workspace-volume-gateway`, `cli-proxy-api`, `cube-api` and `cube-proxy` through
selector-backed Services. Kubernetes owns their EndpointSlices. There is no
Docker address synchronizer, manual slice updater, Cube TCP relay or second local
Kubernetes cluster. Client reconnect/deadlines remain necessary after a TCP break.

## Storage and upgrades

PostgreSQL, Kafka and attachment storage use static local PVs below
`/var/lib/pi-cloud`, with node affinity and `Retain`. Cube Workspace bytes stay in
`runtime/state/cube-shared/volume`, mounted into Cube and the Volume Gateway.
Provider credentials/assets remain in `runtime/state/cli-proxy`, and its writable
configuration is `runtime/secrets/cli-proxy-config.yaml`. Replacing that file
requires replacing the provider Pod so its file mount uses the new inode.

`prepare-self-hosted-k3s.mjs` is an operator-only root preparation step used by the
installer. It prepares directories and the private kubeconfig, and reconciles the
required kubelet task limit. It does not delete existing application data.

Before upgrades, stop new submissions and drain active Runs/seals. Back up PG,
attachment objects, Cube volumes and provider state according to the required
recovery point. Never restore Kafka dispatch offsets behind already issued Tool
commands. Rebuild/import images, validate charts, and deploy matching versions.
Pod readiness is necessary but insufficient: check publication availability and
run an actual Tool request. The optional native/image/fault acceptance scripts
use GPT-6 Luna and isolated resources.

`npm run production:down` uninstalls application and infrastructure releases;
retained PV/PVC data survives. Cube host services remain installed. Start again
with `production:up` using the same configuration and retained volumes. A local
PV cannot move to another machine until its bytes are moved deliberately. Node
loss, database HA and off-host backups are separate operational responsibilities;
see [distributed deployment](DISTRIBUTED_DEPLOYMENT.md) for external authorities.

The October 3 cutover is an **owner-authorized clean reset**, not a generic
migration recipe: old accounts, conversations, images, Workspaces/VMs, PG/Kafka
volumes and business backups were explicitly deleted. Normal deployment never
performs that reset. There is no data rollback to those deleted assets.

## Optional observability

Set `PI_CLOUD_OBSERVABILITY_ENABLED=1` in the private runtime `.env` to install
Prometheus, Alertmanager, Grafana and Jaeger in K3s, then rebuild/import and deploy.
The optional monitoring stack has retained claims and loopback-only operator ports.
Its configuration/rules remain under `deploy/observability`; it adds no execution
authority. See [observability](OBSERVABILITY.md).
