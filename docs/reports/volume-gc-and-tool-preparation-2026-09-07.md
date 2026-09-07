# Volume GC and Tool preparation acceptance — 2026-09-07

Scope: ADR-0152 on the local PiCloud Compose/Cube KVM deployment. Source was the
working-tree change on `78e0ea7f`; the existing guest template was retained.
The operator applied `scripts/update-cube-volume-plugin.mjs`, rolling only
CubeMaster. No broader privileges were added to the Volume gateway.

## Real model and browser results

The public-API + Chrome test used DeepSeek V4 Flash to write a complete Python
algorithm/test module and then edit it in a second Turn. Both Runs completed,
with eight successful remote Tool operations and zero sandbox-reset markers.
Chrome observed animated write/edit preparation before execution; a reload
while the write arguments were being generated restored the same preparing row.
Completed Tools replaced their preparing rows without leftover spinners.

| Run | Preparation first visible | Whole Run |
| --- | ---: | ---: |
| write | 4,524 ms | 20,868 ms |
| edit | 2,898 ms | 18,529 ms |

These are end-to-end model-inclusive timings, not platform-only overhead.
Native Pi usage: 5,313 input, 4,089 output and 91,776 cache-read tokens.
The browser used English UI; Chinese and English labels also pass rendering tests.

The owned-machine test separately ran two paid coding rounds, restarted only
Tool Broker, verified surviving root/home markers and the HTTP process, then
created root-owned `000` files/directories and explicitly released the machine.
Both Runs completed (13,039 / 23,124 ms), the original VM identity survived the
Broker restart, and Volume GC reached `storage_purged_at` automatically. Native
usage: 5,519 input, 3,869 output and 116,864 cache-read tokens. No manual filesystem
cleanup was used for this final trial. No host power-loss recovery claim is made.

Machine-readable evidence: `tool-preparation-acceptance-latest.json` and
`machine-failure-acceptance-latest.json`.

## Fault tests and discovered defects

- The unchanged Controller plugin was exercised with an isolated temporary
  Docker mount: root-owned `000` files, absent/wrong marker, partial deletion
  failure, repeated Destroy after lost ACK, and an external symlink canary.
- Gateway/reaper tests preserve identity through Cube 409 and reject finalization
  before bytes are removed. Retiring metadata is an atomic rename; a restarted
  finalizer can finish without recreating an empty Volume.
- An initial real second Turn failed because a World State reset notice appeared
  between a Tool call and result. Pi's Responses converter inserted a synthetic
  missing result, causing the Provider to reject the actual duplicate output.
  This was fixed at the source: stable elastic allocation identity, actual Broker
  binding in the Runner, and model-visible World State only at clean boundaries.
  A regression uses Pi's native Responses converter to assert one Tool output.
- A Preview test assumed peer closure and server cleanup happened in the same
  event-loop tick; it now waits for actual stream destruction rather than racing.

Final deterministic checks: Tool Broker 85 passed / 3 environment-gated skips;
selected Runner/adapter/World State tests 31 passed; Web rendering/reducer/i18n
tests 48 passed. Type, format, documentation, image-closure and runtime-policy
checks passed. All final temporary Sessions/Workspaces/machines were released;
existing user resources were not deleted.

## Reproduce

```bash
node --import tsx scripts/run-volume-deletion-contract-check.mjs
PI_CLOUD_LIVE_TOOL_PREPARATION_CHECK=1 node --import tsx scripts/run-live-tool-preparation-check.mjs
PI_CLOUD_LIVE_MACHINE_FAILURE_CHECK=1 node --import tsx scripts/run-live-machine-failure-check.mjs
```

Live checks consume tokens and allocate disposable resources. The machine check
also restarts Tool Broker and refuses to do so while another Run is active.
