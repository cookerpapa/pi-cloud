# PiCloud trusted Pi Worker pool

This chart deploys a stateless, horizontally scalable Pi SDK Worker pool. All
replicas consume the same PostgreSQL-backed Run queue. `LISTEN/NOTIFY` is only a
latency hint; PostgreSQL remains the queue and Run/Attempt authority.

Workers never execute model-generated code. `read/write/edit/bash` cross the
Tool Broker and execute in CubeSandbox. A Worker PVC contains only its boot
ledger. Pi SessionStorage is durable PostgreSQL state. Workers publish both
browser-visible events and complete Session mutations directly to private Kafka.
One Projector group drives PG history, live views and Tool routing. There is no
Control Plane Ingest relay in this path.

## Required Secret

Create one Secret in the Worker namespace:

```bash
kubectl -n pi-cloud-workers create secret generic pi-cloud-pi-worker-secrets \
  --from-file=database-url=/private/pgbouncer-url \
  --from-file=database-notification-url=/private/direct-postgresql-url \
  --from-file=supervisor-enrollment-token=/private/supervisor-enrollment-token \
  --from-file=supervisor-management-token=/private/supervisor-management-token \
  --from-file=tool-broker-token=/private/tool-broker-token \
  --from-file=cli-proxy-api-key=/private/cli-proxy-api-key \
  --from-file=metrics-token=/private/metrics-token
```

The regular database URL may use PgBouncer transaction pooling. The notification
URL must target PostgreSQL directly because `LISTEN` is connection-scoped.
`database.maxConnections` bounds the ordinary PostgreSQL pool independently of
`workerPool.capacity`; increase it only after observing pool wait time rather
than multiplying connections for model-waiting Runs.
`services.providerGatewayUrl` points to a separately operated CLIProxyAPI (or an
equivalent provider gateway); Workers receive only its client API key, never an
upstream OAuth refresh token or model-provider API key.

## Install and scale

```bash
helm upgrade --install pi-workers \
  deploy/helm/pi-cloud-pi-worker-pool \
  --namespace pi-cloud-workers \
  --set image.repository=registry.example/pi-cloud/supervisor-host \
  --set image.digest=sha256:...
```

Manual scaling changes `workerPool.replicas`. With KEDA installed, enable
`autoscaling.enabled`; the PostgreSQL scaler counts distinct active/ready physical
Sessions and targets `targetSessionsPerReplica`. Descendant Run counts cannot
create replicas that cannot own those Lanes. `workerPool.capacity` counts families;
`runtime.modelConcurrency` and `runtime.sessionModelConcurrency` limit actual
provider requests separately. Every family shares one renewed owner lease;
task references and operation state prevent stale effects. Scale-in drains
owned families, including their descendants, without taking new families.

The default NetworkPolicy allows DNS and the configured trusted ports only.
Validate rendered manifests with `npm run helm:check` before deployment.
