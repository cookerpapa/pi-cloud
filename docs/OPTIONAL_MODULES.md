# Optional deployment modules

PiCloud's default deployment is the shortest production path required for
the conversation product:

```text
Web → Control Plane → PostgreSQL queue → Pi Worker → Tool Broker → Cube
                    ↘ PostgreSQL Session storage
Worker → Authority Gate → Kafka acks=all → Gateway snapshot-first SSE
```

The Control Plane exposes authentication, model/proxy settings, projects,
conversations, Workspaces, Runs, cancellation, steer and durable SSE. Dormant
research APIs are not compiled into the product.

## Observability

Prometheus, Jaeger and Grafana are already an explicit Compose profile:

```bash
npm run production:up:observability
```

## Removed product surfaces

The following unfinished product workflows are not part of either core or the
advanced Web product: structured Diff, Artifact download,
test-result navigation, Workspace rollback, generic repository import, and
organization, RBAC or audit-search pages. Conversation forks, recursive tree
deletion and conversation-tail pruning are current core features; none of them
pretends to roll back Workspace bytes. Reintroducing a removed workflow
requires a new end-to-end product decision, public contract and acceptance
suite.
