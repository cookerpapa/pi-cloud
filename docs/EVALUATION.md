# Evaluation

Pi Cloud separates deterministic protocol checks, live infrastructure
acceptance and model-quality experiments. A checked-in report is current only
when its workload exercises the PostgreSQL queue/SessionStorage, Kafka AcceptedFact
path, persistent Cube Volume and CubeSandbox KVM runtime described in the
current architecture ADR.

## Deterministic gates

```bash
npm run check
npm run eval:faults
```

The ordinary test suite covers queue claims, Session ordering, leases/fences,
Pi SessionStorage, event ordering, cancellation, Tool ambiguity, Workspace
settlement and tenant isolation without spending model tokens.

`eval:faults` selects named process/protocol failure cases from
`eval/fault-cases.json`. Every manifest entry must refer to a test that exists
in the current tree. The suite is deterministic fault injection, not a
multi-node chaos claim. The latest current-topology run is recorded in the
[fault evaluation report](reports/fault-eval-latest.md).

The stream-independence and interrupted-prefix fault cases verify that a public
stream outage cannot roll back a complete Pi message, while a visible failed
prefix still survives Worker replacement.

## Live-event durability

```bash
npm run eval:postgres-session-projection
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
```

The production stream is:

```text
Pi event ─┐
          ├-> per-Run Fact Stream / multiplexed Worker connection -> Authority Gate -> AcceptedFactBus
Pi entry ─┘                                      ├-> Gateway live tail -> snapshot-first SSE
                                                 └-> Kafka consumer group -> PostgreSQL SessionStorage
```

Kafka `acks=all` precedes visibility. Kafka retains a bounded
log of Assistant text deltas, complete Tool/lifecycle Items and Pi mutations;
PostgreSQL stores Pi-native complete messages once. The two checks separately
measure Kafka/Gateway ordering and PostgreSQL complete-message projection
latency/WAL, so token fragments never masquerade as canonical database state.

Interactive latency reports use distinct boundaries:

- `firstDurableActivityMs` is the first Kafka-acknowledged
  `assistant.text.delta` or complete `tool.started` event for the Turn;
- `firstToolStartedMs` is the first durable Tool start and is `null` for a
  Tool-free Turn;
- `firstAssistantTextMs` is literally the first Assistant text delta. A model
  may emit Tool Calls without text, so this can occur only after several Tools;
- `settledMs` ends at the durable terminal event and committed Run state.

Reports must not call `firstAssistantTextMs` generic "time to first response"
for coding tasks. Local optimistic UI states such as “thinking” are not durable
Agent activity and are measured separately by browser interaction checks.

Current evidence:

- [PostgreSQL Session projection](reports/postgres-session-projection-latest.md)
- [Pi SDK stream shape](reports/pi-sdk-stream-shape-latest.md)

These reports are single-host evidence, not managed-PostgreSQL HA or
multi-region saturation claims.

## Cube and real-model acceptance

```bash
npm run cubesandbox:live-check
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_WORKER_POOL_CHECK=1 npm run production:worker-pool-check
PI_CLOUD_LIVE_DIRECTORY_PICKER_CHECK=1 npm run production:directory-picker-check
```

The Cube gate attests real KVM guests, tenant-separated persistent Workspaces,
credential isolation, egress policy, resource/output bounds, authority
rotation, cancellation and cleanup. The production gate consumes real model
tokens and verifies:

- pure chat does not activate Cube;
- multi-round coding uses fenced remote Tools;
- a warm Cube may be reused under a newer authority;
- a fresh Cube can attach the same persistent Workspace Volume;
- the persistent Volume contains no retired external platform Git metadata;
- any `.git` directory in the Workspace is ordinary user/Agent-managed state;
- cross-tenant conversation access is denied;
- retained Cubes are reaped by the declared lifecycle.

Current evidence:

- [Cube KVM acceptance](reports/cubesandbox-kvm-acceptance-latest.md)
- [Production acceptance](reports/cubesandbox-production-acceptance-latest.md)
- [Shared Worker-pool acceptance](reports/pi-worker-pool-acceptance-latest.md)
- [Recursive Subagent acceptance](reports/subagent-production-acceptance-latest.json)
- [Interactive Snake Preview acceptance](reports/snake-preview-acceptance-latest.json)
- [Browser UI control acceptance](reports/browser-ui-acceptance-latest.json)
- [Exclusive folder chooser acceptance](reports/directory-picker-acceptance-latest.json)

The Snake gate requires a real model to create and serve a multi-file browser
game, then drives start, keyboard movement, pause and reset in headless Chrome
through the authenticated isolated Preview Origin. The browser UI gate
clicks the ordinary user-facing controls for authentication, localization,
conversation/tree navigation, Workspace Terminal, Fork/Delete, resource
lifecycle, directory selection and SSH. It does not mutate administrator model
or proxy settings. The focused folder-chooser gate avoids model variability: it
allocates a real exclusive Cube, creates a UID/GID 1000 directory through the
tenant-bound Tool Broker path, selects it in the GNOME-style browser, verifies
the trusted listing API and releases the machine.

## Load and live restart acceptance

```bash
npm run eval:load
PI_CLOUD_LIVE_MULTI_TENANT_LOAD=1 npm run production:multi-tenant-model-load
PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 npm run production:control-plane-restart-check
PI_CLOUD_LIVE_DEVELOPMENT_ENVIRONMENT_CHECK=1 npm run production:development-environment-check
```

`eval:load` measures 10/50/100 concurrent cold-Session creates and reads; it
does not claim equivalent active model/Cube concurrency. The multi-tenant gate
uses real simultaneous model Runs across the shared Worker pool. Restart gates
kill or replace one named process only after a visible stream boundary, then
verify ordered completion/recovery from PostgreSQL and Kafka-backed snapshots.

Current evidence:

- [Control Plane load](reports/control-plane-load-latest.md)
- [Multi-tenant real-model load](reports/multi-tenant-model-load-latest.md)
- [Control Plane restart](reports/control-plane-restart-acceptance-latest.md)
- [Exclusive development environment recovery](reports/development-environment-acceptance-latest.json)

## Long-context compaction

```bash
PI_CLOUD_LIVE_LONG_CONTEXT_CHECK=1 \
  npm run production:long-context-check
```

This expensive gate performs real coding Turns until Pi completes at least two
native Compactions, then verifies early-context recall, further Tool use and
recovery on a different Worker. It proves bounded PostgreSQL SessionStorage
restoration rather than lifetime JSONL download. See
[the compaction report](reports/long-context-compaction-acceptance-latest.md).

## Interpreting evidence

Every performance or reliability statement must name the tested commit,
hardware/topology, workload and exclusions. A report generated by a retired
Temporal, gVisor, MinIO/S3 or Kopia topology is historical and is deliberately
not retained as a `latest` report in the current tree. Multi-node failover,
broker loss and capacity targets remain unproven until run on that topology.
