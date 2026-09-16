# Local Kubernetes Pi Workers

This development profile moves the trusted Pi Worker pool from Compose into a
single-node k3d cluster while leaving the rest of the one-host topology in
Compose.

```text
k3d Pi Workers -> bridged PostgreSQL / Control Plane / Tool Broker
              -> Kafka / Provider Gateway / provider egress proxy
```

Workers consume the same PostgreSQL Run queue as Compose Workers. The cutover
checks for active Runs before building and again before cutover, switches Control Plane management
routes, deploys the Helm pool and verifies enrollment/readiness. Perform it in
a maintenance window without new submissions; the initial check is not an
admission lock.

On failed cutover or explicit downgrade, the helper first confirms the Kubernetes
executor Pods are gone, then restores Compose and each Worker's prior running/
stopped state. Failed shutdown aborts rollback rather than enabling both pools.
An upgrade within Kubernetes rolls back to the previous Helm revision. Readiness
checks verify the requested Worker image as well as enrollment and routes.
Compose restoration uses the installed production Worker image and template;
it restores the deployment mode/capacity, not a historical binary version.

```bash
npm run kubernetes:pi-workers:up
npm run kubernetes:pi-workers:status
npm run kubernetes:pi-workers:check
npm run kubernetes:pi-workers:down
```

Each Worker receives a pooled database URL plus a direct notification URL.
Workers append directly to Kafka; PostgreSQL owns execution authority and
materialized native history. Local Worker PVCs contain only boot identity.
The helper bridges every dependency and exposes the short Kafka hostnames
returned by broker metadata in the Worker namespace. It carries the runtime's
Kafka partition count, family/model limits, PG pool size and Child limits into
Helm values instead of reverting to defaults. Re-run the helper after dependency
container IPs change; this development bridge is not a service-discovery controller.

This profile validates packaging and horizontal Worker behavior, not
multi-node availability. Use the distributed chart for external PostgreSQL,
Workspace storage and Cube failure testing.
