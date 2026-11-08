# Execution boundaries: Pi, OpenMA and BoxLite

Scope: Issues #12–#16, ADR-0305. Source findings below are separate from runtime
acceptance. Source, isolated transport and local BoxLite verification have run;
production publication is tracked separately in BACKLOG.

## Native tool registration

Pinned `@earendil-works/pi-durable@1.0.0`,
`dist/harness/tool.js`, `ToolTask.phases.call`:

1. Resolve the registered tool, prepare and validate arguments.
2. Run public `beforeTool` hooks and validate their final arguments again.
3. Commit the running slot and `execute` checkpoint using public Storage.
4. Invoke the registered `execute`, then perform native result settlement.

PiCloud registers generic proxies using those public APIs. The Worker proxy
prepares only a logical target and a reply waiter. It does not create a VM or
execute the business handler. Its Storage adapter associates the final validated
intent with dispatch in that same Kafka transaction. `execute` awaits the waiter;
Pi remains responsible for the canonical result and abort behavior.

An ordinary `execute` implementation could publish another Session record. That
would be a valid SDK integration, but would add one commit and a crash gap after
the native intent. Copying arguments into a second document would also duplicate
input. The retained design uses zero additional dispatch commits; native-format
knowledge is concentrated in `durableToolState` / the private Storage adapter.
No Pi-core change, independent producer, operation table or automatic unsafe
replay is introduced. Hook and final-argument mismatch must reject before send.
The native contract probe compares public execution ordering with the atomic
proxy; counts are assertions in tests, not measured latency claims.

## Provider API comparison

OpenMA source baseline
[`a4a5ab7`](https://github.com/openma-ai/open-managed-agents/tree/a4a5ab7075c636529533f9cf14b602dc18dad6ff):
[sandbox ports](https://github.com/openma-ai/open-managed-agents/blob/a4a5ab7075c636529533f9cf14b602dc18dad6ff/packages/sandbox/src/ports.ts),
[E2B adapter](https://github.com/openma-ai/open-managed-agents/blob/a4a5ab7075c636529533f9cf14b602dc18dad6ff/packages/sandbox-adapter-e2b/src/e2b.ts),
[Daytona adapter](https://github.com/openma-ai/open-managed-agents/blob/a4a5ab7075c636529533f9cf14b602dc18dad6ff/packages/sandbox-adapter-daytona/src/daytona.ts).
The useful pattern is a platform-owned operation/lifecycle interface behind
ordinary registered tools. Adopt that boundary without importing another Agent
runtime or scheduler. A provider API response is not proof of transactional shell
effects. Post-retrieval output limits also cannot substitute for source truncation.

PiCloud now routes fixed tools through `SandboxToolExecutor`, implemented by
`CubeSandboxToolExecutor`. Generic routing no longer classifies Cube transport
errors or builds its request payload. The adapter preserves node/boot/position
fencing, guest-side truncation, image references and original Worker boot replies.

**Keep Cubelet completion ownership for this release.** Replacing it with an HTTP
caller that waits for output would tie delivery to a disposable caller. A future
closed-source provider could expose durable execution IDs and retained results,
or run a platform-controlled receiver beside its API. Either option needs explicit
retention, cancellation and lost-ACK contracts. A common API does not make these
guarantees automatic; no second result database was added here.

## BoxLite decision

Baseline: [v0.12.0, f5593da](https://github.com/boxlite-ai/boxlite/tree/f5593da68c23cb0c0a0d230eb9cb01e04cccd610).
Its [core license](https://github.com/boxlite-ai/boxlite/blob/f5593da68c23cb0c0a0d230eb9cb01e04cccd610/LICENSE)
is Apache-2.0. The [Runner license](https://github.com/boxlite-ai/boxlite/blob/f5593da68c23cb0c0a0d230eb9cb01e04cccd610/apps/runner/LICENSE)
and several cloud applications use AGPL-3.0; do not describe the full cloud stack
as the same artifact as the core library.

| Concern | BoxLite evidence | PiCloud integration consequence |
| --- | --- | --- |
| Execution | Guest executions have IDs, inventory, control handles and attachable output. | A provider adapter can preserve an execution handle; it still needs Session fencing and original callback identity. |
| Results | Guest registry retains up to 64 completed entries / 8 MiB, with a 5-minute grace and 15-minute metadata tombstones. | Bounded guest memory is not durable result delivery after guest death. Keep UNKNOWN and do not replay arbitrary shell. |
| Output | Convenience `SimpleBox.exec` gathers stdout/stderr. | Use a fixed guest tool or low-level streams with bounded source output. |
| Storage | Host directory mounts use virtiofs; retained box disks use QCOW2. | A host mount is not a distributed Volume attachment/deletion protocol. |
| Operations | Library/CLI/standalone REST and the apps API/Runner/Proxy stack are distinct deployment choices. | The latter also introduces its own services and stores; do not adopt it as a supposedly smaller drop-in. |
| Host | Linux execution still needs KVM. | It does not eliminate this WSL host's nested virtualization dependency. |

Sources:
[execution registry](https://github.com/boxlite-ai/boxlite/blob/f5593da68c23cb0c0a0d230eb9cb01e04cccd610/src/guest/src/service/exec/registry.rs),
[Python inventory tests](https://github.com/boxlite-ai/boxlite/blob/f5593da68c23cb0c0a0d230eb9cb01e04cccd610/sdks/python/tests/test_execution_inventory.py),
[SimpleBox](https://github.com/boxlite-ai/boxlite/blob/f5593da68c23cb0c0a0d230eb9cb01e04cccd610/sdks/python/boxlite/simplebox.py),
[volumes](https://github.com/boxlite-ai/boxlite/blob/f5593da68c23cb0c0a0d230eb9cb01e04cccd610/docs/guides/volumes.md),
[Runner](https://github.com/boxlite-ai/boxlite/blob/f5593da68c23cb0c0a0d230eb9cb01e04cccd610/apps/runner/README.md).

Recommendation: defer a production backend. BoxLite could suit a self-contained
single-node executor, but adopting it now would replace working allocation,
Volume closure, boot fencing and metering contracts with new integration work.
`scripts/research/boxlite-capabilities.py` prepares an isolated, pinned capability
probe for caller exit, handle recovery, bounded guest replies, mounts and disk
retention. It installs nothing into production and touches no user Workspace.
It is not the full alternate-runtime security/recovery acceptance suite, and no
speed comparison is claimed without equivalent hardware and workloads.

## Isolated BoxLite result

The Python 0.12.0 wheel was exercised on this WSL2 KVM host with an independent
runtime directory and a fresh Workspace mount. The OCI image was
`docker.io/library/python@sha256:5c84c59004e6679bc98a33930344c6ea3da9e2434869b29bc950e46902b6c383`.
The configuration used one CPU, 512 MiB, `auto_remove=False`, an explicit main
process and no production resources.

After abrupt caller exit, reopening observed the Box as `stopped`; the old
execution handle returned `InvalidStateError`. The shared-directory effect was
present exactly once and was not replayed. An explicit restart successfully ran
a fixed guest program that reduced 200,000 characters to a 51,235-byte JSON reply
before host transfer. A marker in `/root` survived stop/restart. Both probes
confirmed removal of their owned Boxes; no owned shim process remained.

The first probe placed its disk marker in `/tmp`, whose contents did not survive
restart. That failed sample is retained alongside the successful persistent-root
probe; it is not counted as a passing disk-retention check. These observations
apply to the stated local SDK configuration. Detached settings and the separate
Runner service need their own validation, and this is not a Cube/BoxLite speed
comparison. The production recommendation remains to defer adoption until its
allocation, durable completion, storage closure and metering integration is justified.
