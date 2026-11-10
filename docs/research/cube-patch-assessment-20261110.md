# Cube patch assessment after runtime decoupling

Tracking: #24, after the implementation of #17–#23 under
[ADR-0306](../adr/0306-runtime-decoupling-and-continuation.md).
Baseline: CubeSandbox v0.7.3, commit
`4411c96ba8658a959de34693f54f4918db2a432f`; Pi Durable 1.0.0.
[Delivery evidence and limitations](../reports/runtime-decoupling-20261109.md)
describe the actual tested deployment.

This document records the ADR-0306 baseline. The follow-up replacement and resource
assessment is [ADR-0307](../adr/0307-guest-execution-and-session-activity.md) and
[the provider comparison](guest-and-resource-boundaries-20261110.md).

## Verdict

The current Tool execution path still needs Cube source patches. Moving Tool
completion into a Guest application removed the Cubelet Node completion adapter
and its Kafka/PG/object-store dependencies. It did not replace Cubelet's ordered
operation admission, exact cancellation and accepted process lifetime boundary.

A fixed program installed in the Guest template is PiCloud application code,
not a modification of Cube source. A portable Guest operation service invoked
through the provider's ordinary execution API is a plausible next replacement
for the remaining execution extension. This is a design candidate, not a claim
that an unmodified Cube has passed the fault suite.

Zero execution patches and zero patches across Cube are different milestones.
Allocation closure, finite idle expiry, Volume reference proofs, lifecycle
history and independent upstream fixes remain outside the execution-only scope.

## Native interfaces inspected

The upstream [Go Commands API](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/sdk/go/commands.go)
starts Bash through `startProcess` with command, environment and working
directory. The [envd transport](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/sdk/go/envd.go)
uses `/process.Process/Start`, obtains a PID and accumulates stdout/stderr in
builders. Calling arbitrary user commands this way would lose source-side output
bounds. Calling a fixed runner that returns only a small acceptance response can
avoid that problem; final data can use the existing HTTPS callback.

The [PTY API](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/sdk/go/pty.go)
supports reconnecting by PID and independent input, resize and kill calls. Its
documented reconnect behavior is useful evidence of caller-independent processes,
but a PID is not the logical operation, VM boot and ordered closure identity
required by PiCloud. The fixed envd implementation's complete failure semantics
have not been established by this SDK inspection.

The lower-level [Cubelet Exec handler](https://github.com/TencentCloud/CubeSandbox/blob/4411c96ba8658a959de34693f54f4918db2a432f/Cubelet/services/cubebox/exec.go)
allocates a new execution UUID per request. It is not an idempotent operation
endpoint. It also logs its request, so callback capabilities must not simply be
embedded in its command arguments or environment as a replacement transport.

## Remaining source groups and their callers

The maintained stack has two files in `deploy/cubesandbox/patches/`.
`0001-runtime-boundaries.patch` changes 92 paths, including tests and generated
protobuf; `0002-release-dependencies.patch` changes 14 build/dependency paths.
Those counts describe patch footprint, not 106 independent architecture changes.

| Capability | Current source and PiCloud caller | Assessment |
| --- | --- | --- |
| Ordered Tool admission, operation deduplication, boot checks | Cubelet `pkg/execution/manager.go`; Cube API/Master managed routes; `cubesandbox-runtime-client.ts::submitTool` | Still required. Replace with one Guest operation gate or a proven equivalent provider API before removal. |
| Exact cancellation and process lifetime | Cubelet `pkg/execution/containerd.go`, `terminal_input.go`; `cancelTool`; Guest scope launcher | Still required. The replacement must distinguish an active operation from completed background work and survive caller disconnect. |
| Fixed Tool execution, output truncation and image preparation | PiCloud `packages/tool-sandbox`; installed Guest image | Application code, not a Cube source patch. Keep bounds at the source. |
| Final completion and temporary previews | Guest `completion-client.ts`; independent `packages/cube-completion` | Moved out of Cubelet. Old Node completion adapter and Cubelet Kafka/PG/S3 access are removed. |
| Launch/runtime failure delivery | Cubelet `pkg/execution/delivery_http.go` and operation manager | A bounded HTTPS fallback remains. A Guest that never started cannot report its own launch failure. The future adapter must retain truthful rejected/unknown outcomes. |
| Synchronous and asynchronous probes | Cubelet execution probe plus Guest probe; `execution-path-probes.ts` | Native extension remains. A Guest service can implement the round trip; missing replies must not become physical-death evidence. |
| Allocation close-before-create and finite retention | Master/let allocation packages and managed routes; provider `allocation` / `renewRetention` | Separate lifecycle contract. Ordinary command execution does not replace it. |
| Recorded-node absence, paused cleanup and Volume attachment closure | Cubelet Volume reference state, Master Volume routes and pause cleanup; resource reconciliation/deletion | Retain until a provider-native equivalent proves safe physical deletion and quota release. |
| Raw lifecycle history | Cubelet `pkg/lifecyclejournal`, service/API routes; `CubeLifecycleSource` | No pricing or compute integration in Cube. The bounded evidence bridge remains because upstream best-effort notifications alone do not provide the accepted historical coverage contract. |
| Template cleanup, node routing and dependency updates | Master `templatecenter`, sandbox observation/routing, second patch | Independent upstream fix/upgrade candidates. Evaluate against a newer pinned release; not removed by a Guest runner. |

Routes/protobuf and their tests support the corresponding rows; they are not
additional durable authorities. Persistent Workspace quota collection remains
in its independent storage service, not this Cube compute patch.

## Smallest viable execution replacement

Keep Worker public Pi proxies, Kafka intents, Projector admission and the current
HTTPS/Kafka result transport. Only the provider execution adapter changes:

```text
Projector dispatches the committed operation
  → provider adapter targets the current allocation
  → ordinary provider API reaches the fixed Guest operation service
  → Guest checks operation identity / ordered closure and runs the fixed Tool
  → HTTPS completion service → original Kafka reply topic → Worker Harness
```

The Guest gate must be separate from user command processes, keep callback
authority out of user-visible files/logs, and retain sufficient boot-scoped
admission/cancellation state. At cutover there must be exactly one such external
admission authority; do not keep a competing Cubelet gate indefinitely.

Restarting that Guest service is not necessarily restarting the VM. The prototype
must either preserve its admission boundary or expose a new executor incarnation
that refuses old requests. An empty in-memory operation map after a service restart
cannot be treated as proof that earlier commands never ran. This is one concrete
reason a small `exec Bash; POST result` wrapper is not the whole replacement.

This requires application code even if Cube itself is unmodified. The goal is a
portable, bounded responsibility with a clear lifetime, not merely moving the
same code and calling it simpler. Closed providers can fit only if their process,
network and isolation capabilities satisfy that contract.

Before removing the current gate, verify:

- Duplicate and delayed commands, including multiple operations at one Kafka
  offset, cannot execute after the applicable ordered closure.
- Caller/Projector/Worker loss does not rerun the command. Repeated callbacks
  resend finalized bytes; old topics remain protected until native settlement.
- Cancellation targets the exact operation and boot. Lost cancellation replies
  do not prove process exit; completed background work survives.
- Provider stream disconnect and Guest-service restart preserve the declared
  lifetime or produce explicit UNKNOWN, without unsafe replay.
- Text and images are bounded before entering the provider return path. The
  ordinary API does not accumulate the full user output first.
- Guest startup failure, VM loss and expired callback authority remain observable
  without inventing success or hanging forever.

The present batch removes complete, verified replacements only. It does not
enable another production sandbox or delete the remaining admission and physical
cleanup protections merely to reach a zero-patch count.
