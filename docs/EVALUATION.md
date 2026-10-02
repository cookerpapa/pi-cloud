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
npm run browser:presentation:check
```

The ordinary test suite covers queue claims, Session ordering, leases/fences,
Pi SessionStorage, event ordering, cancellation, Tool ambiguity, Volume lifecycle
and tenant isolation without spending model tokens.

The presentation check uses installed Chrome/Chromium and actual React effects,
without accounts or model calls: progressive text under StrictMode, immediate
reconnect-prefix presentation, first-use panel sizing and resize cleanup.

`eval:faults` selects named process/protocol failure cases from
`eval/fault-cases.json`. Every manifest entry must refer to a test that exists
in the current tree and has a passed assertion in Vitest's machine-readable
report; missing or skipped targets fail the gate. CI executes this gate as well
as the general suite. The suite is deterministic fault injection, not a
multi-node chaos claim. The latest current-topology run is recorded in the
[fault evaluation report](reports/indexed-native-log-faults-20260927.json).

Real PostgreSQL cases use two existing opt-in variables:
`PI_CLOUD_POSTGRES_INTEGRATION_URL` and
`PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL`. Set both to the disposable test
PostgreSQL service when running the whole fault gate, as CI does. A skipped
required test is a failed gate. The GitLab note cases use localhost HTTP fault
injection and isolated databases; they do not post to an external GitLab server.

The stream-independence and interrupted-prefix fault cases verify that a public
stream outage cannot roll back a complete Pi message, while a visible failed
prefix still survives Worker replacement.

The [direct Steer acceptance](reports/direct-steer-acceptance-20260930.md) adds
real-PG input races and a Luna/Cube process-fault script:
`PI_CLOUD_LIVE_DIRECT_STEER_CHECK=1 node --import tsx scripts/run-live-direct-steer-check.mjs`.
Canonical input consumption, including consumption during cancellation, decides
retirement versus restoration; an HTTP acknowledgement alone never does.

## Live-event durability

For focused real-browser reconnect diagnostics, see the
[double-request investigation](reports/stream-reopen-investigation-20260909.md).
It distinguishes an intentional stale-snapshot replacement from duplicate live
subscriptions and does not claim the original intermittent condition fixed.

```bash
npm run eval:postgres-session-projection
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
```

The production stream is:

```text
Pi event / native Entry / Tool command
    -> trusted Worker -> control-plane ingress -> Kafka transaction commit
    -> one Session Projector group
         ├-> PostgreSQL SessionStorage
         ├-> live view -> snapshot-first SSE
         └-> owning Tool executor -> Cube
```

Kafka RF3/transaction commit precedes visibility. Kafka retains a bounded
log of Assistant text deltas, complete Tool/lifecycle Items and Pi mutations;
PostgreSQL stores Pi-native complete messages once. The two checks separately
measure Kafka/Gateway ordering and PostgreSQL complete-message projection
latency/WAL, so token fragments never masquerade as canonical database state.

Interactive latency reports use distinct boundaries:

- `firstDurableActivityMs` is the first Kafka-acknowledged text delta, Tool
  preparation/start, or hosted-search start for the Turn;
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

These reports are single-host evidence, not managed-PostgreSQL HA or
multi-region saturation claims.

## Cube and real-model acceptance

For missing-Workspace recovery onto a development machine, run
`PI_CLOUD_LIVE_WORKSPACE_REBIND_CHECK=1 node --import tsx scripts/run-live-workspace-rebind-check.mjs /tmp/workspace-rebind-live.json`.
It creates its own tenant/Workspace/machine, rebinds through the browser's machine
and directory picker, and uses Luna to verify retained conversation context and
actual Tool cwd. Cleanup releases only its own machine and revokes its credential.

```bash
npm run cubesandbox:live-check
PI_CLOUD_LIVE_CUBESANDBOX_CHECK=1 npm run production:check
PI_CLOUD_LIVE_WORKER_POOL_CHECK=1 npm run production:worker-pool-check
PI_CLOUD_LIVE_DIRECTORY_PICKER_CHECK=1 npm run production:directory-picker-check
PI_CLOUD_LIVE_NATIVE_TOOL_CHECK=1 npm run production:native-tool-check
```

The native Tool check explicitly uses GPT-6 Luna for three coding rounds. It
requires real write/read/edit/bash calls, checks a 1.5MB command's bounded tail,
records model time separately from Tool boundaries, and releases its test Session
and Workspace through the product API. It never selects DeepSeek implicitly.

For temporary Tool logs, run
`PI_CLOUD_LIVE_TOOL_PROGRESS_CHECK=1 node --import tsx scripts/run-live-tool-progress-check.mjs`.
It uses Luna, Cube and Chrome to check noisy/silent commands, reload, cancellation
and subsequent coding. Adding `PI_CLOUD_TOOL_PROGRESS_RESTART_CHECK=1` permits
SIGKILL/start of the local Control Plane only after excluding unrelated active Runs.

For [ADR-0201](adr/0201-runtime-activity-and-path-probes.md), run
`PI_CLOUD_LIVE_RUNTIME_STATUS_CHECK=1 node --import tsx scripts/run-live-runtime-status-check.mjs /tmp/runtime-status-live.json`.
It uses real GPT-6 Luna, Cube and Chrome, verifies quiet-Tool path probes without
native log growth, pauses/replaces Control Plane while PG renewals continue,
checks cancellation and Worker replacement, and verifies the uncertain command
is not replayed. Process faults require that only this check's Run is active;
cleanup restores stopped services and revokes the disposable tenant credential.

For [ADR-0211](adr/0211-execution-path-and-runtime-probes.md), run
`PI_CLOUD_LIVE_EXECUTION_PROBE_CHECK=1 npm run production:execution-probe-check -- /tmp/execution-probes-live.json`.
The matched Worker/Control Plane/Cube/guest set must be installed first. It uses
GPT-6 Luna to check pure chat without allocation and a successful complete probe
while a real Bash is still executing. It checks direct native VM responses,
executor-boot rejection, an undeliverable fixture reply destination, pause without
probe-triggered resume, and absence of probe content in native history. Only its
own VM is paused, and all owned resources are removed. Repeat the existing owned
Cube handoff/control-plane restart gate for recovery across process replacement.

For ADR-0197 storage acceptance, run
`PI_CLOUD_LIVE_INDEXED_LOG_CHECK=1 node --import tsx scripts/run-live-indexed-log-check.mjs /tmp/indexed-log-live.json`.
It uses real GPT-6 Luna/Cube Tools and a Child Lane, creates a human Fork, then
seeds one native Compaction through the quiescent storage port and checks a new
Worker-owned Run reads that summary and the existing Workspace. This verifies
compacted cold storage without changing model windows or claiming an automatic
900,000-token compaction test. The real image/cold-Worker gate can write a separate
report with
`PI_CLOUD_LIVE_IMAGE_CHECK=1 node --import tsx scripts/run-live-image-attachment-check.mjs /tmp/indexed-log-images.json`.

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
tenant-bound sandbox-management path, selects it in the GNOME-style browser, verifies
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
uses real simultaneous model Runs across the shared Worker pool. The Control Plane restart gate waits for a file marker proving native Bash
execution, kills/restarts only Control Plane, then verifies the same Worker/Run
and one shell execution. Kafka broker failure retains its separate streaming/ISR
gate. Workers publish through ingress, so these tests do not assume continued
publication while every ingress is offline. See the
[matched cutover evidence](reports/cube-execution-rollout-20261001.md).

General live gates default to GPT-6 Luna. Provider-specific diagnostic inputs use
`PI_CLOUD_LIVE_SUBAGENT_PROVIDER=openai-codex`,
`PI_CLOUD_LIVE_MACHINE_PROVIDER=openai-codex`, or
`PI_CLOUD_LIVE_FAULT_PROVIDER=openai-codex`, respectively. These are test inputs,
not production fallback settings. A GPT-only pass does not replace the mixed-
provider/Compaction gate. Worker inventory follows the deployed Compose or local
Kubernetes pool; process faults restart existing containers, not a new image.

Current evidence:

- [Control Plane load](reports/control-plane-load-latest.md)
- [Multi-tenant real-model load](reports/multi-tenant-model-load-latest.md)
- [Control Plane restart during Cube execution](reports/cube-cutover-handoff-restart-20261001.json)
- [Exclusive development environment recovery](reports/cube-cutover-development-machine-20261001.json)

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
Temporal, gVisor, per-Run MinIO archives or Kopia topology is historical and is deliberately
not retained as a `latest` report in the current tree. Multi-node failover,
broker loss and capacity targets remain unproven until run on that topology.

## Session images and GPT-6

General live checks now default to GPT-6 Luna. Explicit DeepSeek and cross-provider
scenarios select Flash. The two DeepSeek hosted-search probes retain their real
search-result assertions and currently fail while Responses ignores `web_search`;
they are diagnostics for upstream restoration, not passing release evidence.

`PI_CLOUD_LIVE_GPT6_CHECK=1 node scripts/run-live-gpt6-capability-check.mjs`
checks actual GPT-6 Luna function calls, image Tool results and hosted search.
`PI_CLOUD_LIVE_IMAGE_CHECK=1 node --import tsx scripts/run-live-image-attachment-check.mjs`
creates a disposable Cube Workspace, reads repeated >5 MiB images at high/original
quality, overwrites the source and replaces an idle Worker. Compose keeps the
other Worker running for an actual owner change; the local Kubernetes mode
restarts the owning Pod. The
final Run must identify earlier image-only digits after cold restore without any
file Tools. Test fixture digits are verified only after that answer. The script
refuses the restart if any other Run is active and cleans its Session/Workspace.

Set `PI_CLOUD_POSTGRES_INTEGRATION_URL` to an isolated PostgreSQL administrator
endpoint for `packages/session-attachments/test/storage.postgres.test.ts`; it
creates/drops its own database. This exercises real row locks, unprojected-upload
protection, native Fork retention and cleanup races rather than treating PGlite
socket error handling as PostgreSQL fault evidence.
