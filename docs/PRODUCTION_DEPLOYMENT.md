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
Under ADR-0215 the current self-hosted profile has no fixed Pod CPU/memory limits,
Go memory ceiling or kubelet task ceiling. Scheduling requests and measured Worker
memory-pressure admission remain. Native image processing still needs real memory;
source/transport bounds are documented in the Cube provider contract. Older fixed
limits and their failures are historical acceptance evidence, not current settings.

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

`npm run release:evidence -- --image-version <release>` records each image's
digest and original OCI source revision. Application images must match the release
revision. A guest reused by build-input identity may keep its older source revision:
the collector exports that commit to a temporary directory and verifies its guest
input hash before accepting it. Keep the source commit available in the local Git
object database (fetch the needed history if using a shallow checkout). Missing
source or changed guest inputs fails verification; tags and OCI labels are not rewritten.

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

Cube upgrades use the full `cubesandbox:cluster-install` workflow: it installs the
pinned native patches and current completion adapter. A shared Helm post-renderer
adds the POSIX configuration, shared mounts, completion Secret and credential
fingerprints before Kubernetes receives the release. Completion reconciliation
uses the same renderer and retained Helm values; it no longer patches workloads
after deployment. Use this maintained path for every upgrade: omitting the
renderer can still remove required resources. End existing
VMs before changing the Cube Node DaemonSet; its Pod/network namespace is recreated.
The first cutover adopts the two named installer-owned ConfigMap/Secret objects
after rejecting foreign Helm ownership. Preserve intended image values during
that cutover if earlier manual updates diverged from Helm's stored values.
Subsequent rollbacks use the stored rendered release; a pre-cutover rollback needs
the old complete installer. See [ADR-0217](adr/0217-declarative-cube-release.md).

On an already prepared cluster, a matched runtime upgrade can reuse the same
renderer with retained Helm values, without repeating root-only host preparation:

```bash
PI_CLOUD_IMAGE_VERSION=<release> node scripts/build-cubesandbox-runtime.mjs
# Import the matching cube-api, cube-master and cubelet images into K3s first.
PI_CLOUD_CUBE_IMAGE_VERSION=<release> node scripts/configure-cube-completion.mjs
```

This changes all three native image values in one rendered Helm release. Existing
VMs must be drained before Node replacement. Application deployment waits for a
ready Cubelet of the desired image and then verifies native/completion identities.
Migration 175 removes obsolete terminal lease mirrors; drain the old Control Plane
before applying it and use matching schema/application state for rollback.
The completion image build requires `PI_CLOUD_CUBE_PATCH_ID` matching the actual
base image, so a stale local `production` tag cannot silently produce a release.
Template retention shares a 30-second deletion budget across registration phases
and stops after an unconfirmed delete. Remaining targets stay in Cube's inventory;
auxiliary cleanup cannot add one full timeout per historical replica to a release.
Template and rootfs cleanup resolve current addresses from recorded stable node
IDs (ADR-0233). Stored replica/job IPs are historical observations. Missing current
registration retains cleanup evidence; it never selects a replacement node by IP.
Platform deployment checks the actual CubeMaster/Cubelet shared path, Cubelet
configuration mount, native patch version and completion source identity before
changing the application. It refuses a mismatched runtime rather than accepting a
healthy Pod as proof of a working Tool path.

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

The October 7 source repairs add migration 182's Session activity index and
ADR-0234's shared Gateway access. Apply the migration through the normal bootstrap
Job and retain the Gateway's `Recreate` strategy. Drain Gateway requests for
upgrade or rollback; no Cube host-protocol or guest-template change is needed for
these repairs. The source verification record does not claim a production rollout.

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
