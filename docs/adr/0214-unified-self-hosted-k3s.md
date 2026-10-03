# ADR-0214: One K3s deployment for the self-hosted runtime

Status: implemented and deployed (2026-10-03).
Acceptance: [K3s cutover report](../reports/k3s-migration-20261003.md).

## Problem and acceptance

The self-hosted profile runs Cube in K3s and the platform in Docker Compose.
Selectorless Services and manually refreshed EndpointSlices bridge Docker IPs.
A container replacement can leave Cube completion clients connected to an old
PostgreSQL, Kafka or attachment-store endpoint. Updating a slice is not proof
that every existing client has reconnected.

The owner approved moving the deployment into the existing K3s cluster. Acceptance:

- start with empty PiCloud business state: the owner explicitly requested deletion
  of existing accounts, conversations, Workspaces/VMs, images and PG/Kafka data;
  retain deployment credentials/configuration to operate the replacement;
- use selector-backed Services, with no Docker IP discovery or relay for Cube API;
- preserve the existing local Web/admin/provider-management/SSH entry points;
- cold reads, real Luna Tool/image execution and Pod replacement work;
- deployment, status, logs and live acceptance use Kubernetes; Docker is only an
  image build/import tool and a one-time migration source;
- one active deployment; no old business-data backup or parallel runtime;
  no VM deletion or effect replay as a migration/reconnect mechanism.

## Decision

Reuse the platform and Worker Helm charts. A separate self-hosted infrastructure
release installs the pinned PostgreSQL, three Kafka nodes, SeaweedFS and provider
gateway before the platform's migration Job. The release separation is deployment
ordering, not another durable scheduler. Distributed installations can continue
to supply external infrastructure through the same ports.

The single-node profile shares the existing `cube-system` namespace with Cube.
The optional monitoring bundle also uses Kubernetes resources. Its stable `postgres`, `kafka-1..3`, `session-images` and `control-plane` Services
replace the old selectorless resources in place, preserving Service IPs and
Cube completion configuration. Kubernetes owns their endpoints. Namespace
membership is not the untrusted-code boundary: only Cube KVM guests run user
code; Worker and control-plane Pods retain their existing restricted identities.
No compatibility bridge remains after cutover.

Stateful services use static local PVs with node affinity and `Retain`, and
retained PVCs. After admission is stopped and work drained, delete the old PiCloud business
state and initialize empty directories in a dedicated K3s-owned location. Never use a
Docker-managed volume as the permanent PV: Docker volume pruning must not erase
active Kubernetes data. Reuse the current persistent Cube volume path, clearing old Workspace bytes
after confirmed VM retirement, without creating another Workspace authority. Preserve provider writable state on its
own volume. Delete old PiCloud data volumes and business-data backups as requested.

The local profile exposes the configured host ports/address; distributed installs
retain Ingress/LoadBalancer. Fixed host ports require non-overlapping replacement.
The self-hosted kubelet permits 1,024 tasks per Pod, matching the former
control-plane container budget: 32 partition producers require native Kafka
threads and exhaust a 128-task limit. K3s owns process restart and service discovery, while existing PG leases, Kafka
fencing and Cube accepted-operation semantics still own execution. A new Pod does
not mean an uncertain shell command can be retried.

## Adopt-before-build evidence

- [K3s](https://docs.k3s.io/) is a CNCF-conformant Kubernetes distribution
  (Apache-2.0, [source/releases](https://github.com/k3s-io/k3s)); reuse the installed
  v1.36.2+k3s1 rather than adding another local cluster.
- [Kubernetes StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
  supply stable identity and retained claims. [Local volumes](https://kubernetes.io/docs/concepts/storage/volumes/#local)
  require node affinity and cannot provide node-loss failover. Native Deployments,
  Services and Helm are sufficient for this measured one-node deployment.
- [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg) is an actively
  maintained Apache-2.0 PostgreSQL operator with managed replication/recovery and
  [imports](https://cloudnative-pg.io/docs/current/database_import/). It is a strong
  option when adding independent database nodes. Adopting it now would also change
  database lifecycle/image/backup management during a service-discovery migration.
- [Strimzi](https://github.com/strimzi/strimzi-kafka-operator) is an actively
  maintained Apache-2.0 CNCF Kafka operator. Its [deployment contracts](https://strimzi.io/docs/operators/latest/deploying.html)
  manage Kafka resources, node pools, storage and upgrades. The current requirement
  is a bounded one-node, three-process Kafka deployment. It does not justify
  building a competing Kafka operator; independent-node HA will require a new
  deployment decision using the operator.

Retain the exact existing database/broker/store images for the cutover. Charts
declare bounded Kubernetes resources; they do not implement database failover,
replication, volume migration or another scheduling loop. Multi-node database
operations must revisit the operators above instead of extending custom scripts.

## Failure, export and rollback

Service identity survives Pod IP changes. Broken TCP connections still require
client reconnect and finite request deadlines; test this independently of DNS.
K3s does not guarantee exactly-once effects or recover a physically lost local PV.
Three Kafka processes on one machine retain R=3 semantics, not machine-level HA.
The K3s management datastore stays independent of PiCloud's PostgreSQL.

The owner explicitly replaced data-preserving migration with a clean reset.
There is no rollback to deleted business data. Save deployment configuration,
then recover forward or roll back application images against the new authoritative
state. Future Helm uninstall must not delete newly created data. Never
automatically restore stale Kafka dispatch offsets.
