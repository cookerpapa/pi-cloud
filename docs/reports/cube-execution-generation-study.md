# Cube final-entry isolation study

2026-09-08. Research only: no Cube/guest execution-generation protocol was
implemented or claimed by the Kafka Tool-command change (ADR-0157).

## Evidence scope

PiCloud pins Cube v0.6.0; the local clean source was
`8721dd151971ce3c2966482bbd32904ad98f378e`. GitHub's latest stable release at
inspection was [v0.7.0](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.7.0),
published 2026-08-28. Relevant SDK/Exec contracts were checked at that tag too.
Cube's base image pins E2B envd to
[`2026.16`](https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docker/Dockerfile.cube-base).

The checked public contracts do not expose an execution epoch / expected-owner
atomic handoff:

* [Cube Node command options/transport](https://github.com/TencentCloud/CubeSandbox/blob/v0.7.0/sdk/node/src/commands.ts)
  provide command, cwd, environment, user and timeouts and call envd
  `/process.Process/Start`. Sandbox traffic/access tokens authenticate a VM
  connection; they are not monotonically advancing execution authority.
* [Cubelet Exec request](https://github.com/TencentCloud/CubeSandbox/blob/v0.7.0/Cubelet/api/services/cubebox/v1/cubebox.proto)
  carries request/sandbox/container IDs, terminal, args, env and cwd, but no
  execution-epoch handoff field. A request ID alone is not proof of ownership.
* [envd process protocol](https://github.com/e2b-dev/infra/blob/2026.16/packages/envd/spec/process/process.proto)
  supports Start, List, Connect, input and signal operations. Start has process
  config, PTY, tag and stdin; PID/tag selection is not a fencing token.
* [envd Start implementation](https://github.com/e2b-dev/infra/blob/2026.16/packages/envd/internal/services/process/start.go)
  intentionally derives process lifetime from a background context, with an
  optional command timeout, rather than the caller's request context. Losing
  Broker HTTP connectivity must not be interpreted as killing the process.
* [SendSignal](https://github.com/e2b-dev/infra/blob/2026.16/packages/envd/internal/services/process/signal.go)
  supports TERM/KILL for a tracked handler. Its
  [handler](https://github.com/e2b-dev/infra/blob/2026.16/packages/envd/internal/services/process/handler/handler.go)
  signals `cmd.Process`. It uses user/PTY cgroup classes; this is not a durable
  PiCloud Run-owned process-tree ledger or a proof that detached descendants
  and external effects have stopped.

[Cube lifecycle](https://github.com/TencentCloud/CubeSandbox/blob/v0.7.0/docs/guide/lifecycle.md)
offers VM pause/resume and irreversible kill. Pause affects the whole VM and
resume preserves old processes; it does not revoke one Run. Killing an owned
machine would violate the product promise to preserve its services and rootfs.
The upstream [minimal envd proposal](https://github.com/TencentCloud/CubeSandbox/issues/1227)
is a discussion opportunity, not evidence of a shipped fencing feature.

## What would constitute a stronger contract

Keep PostgreSQL as the issuer of execution authority. A Cube-side enforcement
watermark is not a second lease service: it must enforce the issued scope/epoch,
reject backwards epochs, and fail closed after loss of enforcement state until
ownership is re-established.

An upgrade would need a control handoff and a command-admission contract at the
actual launcher, not just another Broker/Proxy preflight query. The new owner's
handoff ACK must establish what happened to every old pending start: started,
cancelled, or explicitly uncertain. A later old-epoch request must not sneak
through an asynchronous queue whose authorization happened before the handoff.
Admission and epoch switching need a shared serialization boundary all the way
to the point at which launching is committed. Merely adding an HTTP header,
rotating a Proxy token or checking PG one more time does not establish this.

Scope matters: independent Sessions may intentionally share a VM. Their local
Fence numbers cannot be compared as one global VM counter. Broker ownership
changes and individual Run cancellation are distinct boundaries; one Run's
closure must not implicitly revoke another valid binding or a human terminal.

PiCloud permits user-controlled full-VM environments. Guest-writable files,
tags and environment variables therefore cannot be the authority for rejecting
old controllers. Any launcher cooperation must be backed by trusted host-side
state and a verified handoff, not a `.fence` file in the Workspace.

## Old-process policy is a separate product decision

The existing envd `tag`, List/Connect and SendSignal APIs can already improve
inspection: tag a launcher with the immutable operation ID and associate its
PID with VM boot identity in the trusted ledger. That helps find the original
invocation after a lost response without starting it again. It is a correlation
mechanism, not authority: PID reuse, guest-controlled tags and descendants must
still be considered. PiCloud currently does not publish this as a recovery API.

The least disruptive target is to prevent newly submitted old-generation
commands after handoff while retaining already-started processes as possible
UNKNOWN effects. That preserves user-owned web servers and watchers and matches
the current semantic-recovery promise; it does not promise a quiescent VM.

A stricter policy requires a trustworthy per-invocation process/group ledger,
termination acknowledgement, verification of remaining descendants, and a rule
for background services. One `kill(pid)` or closing the result stream is not
enough. An already-dispatched external API request can still complete even after
the issuing process is killed; exactly-once external effects require cooperation
from that destination.

Recommended next step: propose/experiment with a Cube-native scoped launcher
handoff, initially promising only stale-start rejection and explicit UNKNOWN
for previously admitted work. Do not silently add strict process destruction,
VM replacement or a resident PiCloud authority daemon to user machines.

Acceptance would pause an old caller immediately before launcher admission,
install/acknowledge a newer generation, resume the old caller, and verify rejection;
then repeat around an already-admitted start, launcher restart and VM resume.
Concurrent valid bindings and previously running Preview services must also be
tested. The Kafka transport/consumer tests do not substitute for those tests.
