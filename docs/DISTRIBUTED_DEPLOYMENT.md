# Distributed Kubernetes deployment

The chart deploys replaceable Web, Control Plane, Pi Worker,
Tool Broker and persistent Volume gateway replicas. It does not install the
external durable authorities.

## External requirements

- PostgreSQL HA plus optional PgBouncer 1.21+ with protocol-level prepared-statement
  tracking enabled (`max_prepared_statements > 0`);
- private-network Kafka with replication factor 3, `min.insync.replicas>=2`
  and bounded AcceptedFact retention; runtime TLS/SASL configuration is not
  wired yet, so authenticated external brokers are not a supported drop-in;
- one direct PostgreSQL connection for migrations, `LISTEN/NOTIFY` and KEDA;
- ReadWriteMany persistent Workspace storage visible to Cube Volume Plugin and
  trusted Volume gateway replicas;
- Cube control/compute plane;
- CNI NetworkPolicy; KEDA and Metrics API when the corresponding autoscalers
  are enabled, plus a node autoscaler if node elasticity is required.

## Topology

```text
Ingress -> Web / Control Plane
                         │
             PostgreSQL ready Run queue
                         │
                shared Pi Worker replicas
                         │
               replicated Tool Broker
                         │
                     Cube API
                         │
                 Cube KVM compute nodes
                         │
              persistent Workspace storage

PG-issued publication scope -> Worker direct append -> Kafka keyed by physical Session
                                                       ↓
                                              Session Projector group
                                              ├-> PG SessionStorage
                                              ├-> live view / SSE
                                              └-> owner Tool executor -> Cube
```

There are no execution Cells, private Worker queues or persistent cold-Session
affinity records. A Workspace binds to a Sandbox Domain for Cube/storage
locality. Any Pi Worker may acquire a cold physical Pi Session, but every
active Run on that Session's main and delegated Lanes must use the same
Worker boot identity under one physical-Session lease. Child tasks do not acquire
independent leases; cold ownership is acquired under a brief `pi_sessions` row lock.

## Deploy

Prepare the namespace, deployment Secrets and shared Workspace PVC first.
Copy the example outside the repository and replace endpoints, images, UUIDs
and CIDRs:

```bash
cp deploy/helm/pi-cloud-platform/values.distributed.example.yaml values.yaml
npm run kubernetes:distributed:render -- --values values.yaml
npm run kubernetes:distributed:preflight -- --values values.yaml
npm run kubernetes:distributed:deploy -- --values values.yaml
```

`render` permits documented placeholders so the chart can be inspected without
a cluster. `preflight` and `deploy` reject example domains, image references,
Git revisions and Cube template IDs, run strict Helm/schema validation, and
check the coupled Turn/lease/replay budgets. Preflight is cluster-read-only:
it checks the actual rendered Secret names/keys, shared PVCs and enabled
autoscaler APIs. It does not prove external service health or volume mountability.
Only `deploy`, after successful checks, applies the configured trusted-namespace
labels and installs/upgrades the release.

Secret keys follow the rendered mounts: database URLs, API/bootstrap credentials,
Cube/Tool credentials, metrics tokens, SSH host key when enabled, and optional
source-control credentials. Worker credentials may use a separate named Secret.
No S3 or Temporal credential is required. External egress CIDRs and TCP ports
must include every configured endpoint, including Kafka and provider gateways.

## Scaling

- Control Plane/Web scale by CPU; projection lag is monitored, not an HPA input;
- Pi Workers scale by PostgreSQL ready Run backlog;
- Tool Broker and Volume gateway have independently configured replica counts;
- Cube compute/node elasticity is configured in the external Cube infrastructure.

KEDA is not a queue authority. If it or its metric is unavailable, the
configured minimum Workers continue polling PostgreSQL.

## Rollout and failure

Workers use rolling replacement and a long termination grace so active Runs can
settle or lose authority safely. Correctness does not depend on a stable Worker
ordinal or local Session cache. A replacement may acquire a Session after its
previous owner's Session lease expires and every affected task closure projects;
stale execution references cannot commit effects. A task timeout alone does not
transfer the physical Session. The migration-137 wire cutover requires drained,
matching-version services; ordinary subsequent same-protocol rollouts can drain.

Before claiming high availability, test on the actual storage/network stack:

- Worker and node loss during model and Tool calls;
- PostgreSQL/PgBouncer failover and notification reconnect;
- Kafka retention/consumer lag and snapshot-first SSE reconnect;
- Tool Broker/Volume gateway owner loss;
- Cube compute-node drain and persistent Volume reattachment;
- KEDA and node-autoscaler scale-up/down under real backlog.
