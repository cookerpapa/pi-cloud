# Terminal and application-preview lifecycle review

Status: review complete, fixes not implemented, 2026-10-20.
Baseline: `901da9ed`; runtime remains `model-runtime-058925bb`, schema 192.
Scope: browser terminal admission/redirect/close, Sandbox control PTY and preview
channels, Cube transport setup/teardown, preview HTTP/SSE/WebSocket and replacement
boundaries. This completes the fourth resource/interaction review slice.

## Findings

### TPR-01 · P2 · A valid terminal owner redirect can lose to the old connection closing

[`WorkspaceTerminalGateway`](../../packages/control-plane/src/workspace-terminal-gateway.ts)
sets `followingRedirect` only after awaiting PG validation of the new owner.
Sandbox control sends the redirect and closes the old WebSocket immediately.
If that close arrives while the lookup is pending, the gateway's old-connection
close handler closes the browser as well. The later validated connection attempt
returns immediately because the proxy is already closed.

The loopback probe holds the authority lookup, sends a valid redirect and then
closes the old peer. The browser closes before validation finishes; releasing
the valid lookup results in zero connections to the new peer. The DB port is
controlled in this probe, not a real PG timing measurement.

Direction: enter a redirect-pending state before the asynchronous lookup, keeping
authority validation mandatory. Associate teardown with the appropriate connection
generation; a failed validation must still terminate the attempt. User close must
win at every stage. Do not replay terminal keystrokes or manufacture a second PTY.

### TPR-02 · P2 · Terminal upstream handshake has no transport deadline

The gateway creates an upstream WebSocket without `handshakeTimeout` and waits
for `open` or `error`. The browser connection has already opened; the UI waits
for `workspace_terminal.ready`. An owner that accepts TCP but never finishes
the WebSocket handshake leaves the UI at “starting”.

A real loopback peer accepts the upgrade request and deliberately withholds its
response. After 16 seconds the browser is still open with zero frames. That is
a finite observation; the absence of an application deadline is established by
the constructor/wait path, not by claiming the test waited forever. User
disconnect still terminates the pending upstream.

Direction: bound connection establishment and surface a retryable failure.
Distinguish this from VM materialization and a healthy connected terminal.
No Run duration limit, automatic VM destruction or forced expiry of an active
Agent is needed.

### TPR-03 · P2 · Preview request cancellation does not reach a pending CONNECT

[`previewConnectionAgent()`](../../packages/control-plane/src/preview-connect.ts)
creates its internal CONNECT request using a separate direct HTTP Agent.
Destroying the returned Agent closes its known sockets, but does not destroy
that pending internal request. The preview gateway uses `agent.destroy()` on
browser response/socket close, so this gap applies during establishment.

The probe starts a real CONNECT, destroys the outer request and its Agent, and
observes the owner socket still open. Completing the controlled peer with a
failure releases it. The existing 15-second deadline bounds each attempt;
this is not an infinite socket-retention claim. Redirect attempts also need to
share cancellation rather than continue after their caller has left.

Direction: make pending establishment part of the returned connection owner's
lifetime, propagate cancellation, and dispose any late success. Preserve the
separate internal-network transport and streaming HTTP/SSE/WebSocket behavior.

### TPR-04 · P2 · Preview establishment can escape the shutdown cleanup pass

[`SandboxControlServer`](../../packages/sandbox-control/src/sandbox-control-server.ts)
checks readiness before `openPreviewConnection()`, but tracks the connection
only after that await. `close()` first marks the server unready and destroys
currently tracked preview sockets. A pending open can finish after that pass;
the continuation checks socket/expiry but not shutdown, sends 200 and adds a
live stream that the shutdown cleanup already missed.

The loopback probe holds the backend open, starts shutdown, and then releases
it. The caller receives 200 with an open stream while shutdown remains pending.
Explicitly closing that owned peer allows shutdown to finish. This demonstrates
late admission during shutdown, not admission after shutdown has completed.
In production the remaining preview-access TTL can bound this stream, but that
is not an appropriate graceful-shutdown gate. No live Control Plane outage or
VM fault is used in this probe.

Direction: track/cancel establishing connections as well as established ones;
recheck shutdown after asynchronous establishment and dispose late streams.
Join the local cleanup without treating it as proof that a user's application
process or the VM has stopped.

## Boundaries that should remain

- The terminal is a human channel outside native Agent history. Its frames do
  not need Kafka durability, replayable keystrokes or another execution queue.
- The UI has explicit connect/disconnect and starts a new terminal when the
  user reconnects. Losing an old WebSocket during Control Plane replacement
  is not itself a new defect or evidence that the Agent died. Transparent PTY
  continuation is not currently promised.
- Terminal close disconnects its stream and attempts to kill that PTY through
  the existing Cube process interface. A shared VM must remain governed by
  its holders. Whole-VM retirement findings are already WVL-01/02, not duplicate
  terminal findings here. A failed kill does not prove physical process death;
  this review does not establish behavior of every detached shell descendant.
- Preview uses a connection-scoped guest TCP relay; closing it targets the
  relay, not the user's application server. HTTP/SSE/WebSocket bytes are streamed
  and do not enter native history. There are no per-byte PG queries.
- Preview's 15-minute access expiry and the terminal's explicit lifetime are
  existing policies. A transparent preview refresh/credential renewal policy,
  if desired later, is a separate product decision. Do not remove authorization
  or add a total Agent deadline to repair these connection races.

## Evidence and limits

Seventy existing tests across ten relevant files pass: terminal gateway/routing,
terminal server/client teardown and bounded input, SSH adapter, preview scope,
HTTP/SSE/WebSocket, direct CONNECT, Cube runtime transport and preview Tool.
Four isolated transport characterizations reproduce TPR-01–04. The probe source
typechecks; it uses real loopback connections and controlled DB/backend ports.

The first preview probe fixture incorrectly waited for the outer request's
`close` before releasing its pending CONNECT. The first shutdown fixture expected
`close()` to have completed before releasing the pending stream. Both timed out.
The final fixtures instead observe cancellation while pending and late admission
while shutdown is draining, then explicitly release their resources. Those first
fixture assumptions are not reported as production findings.

No new browser/xterm rendering run, real KVM PTY descendant test or live Control
Plane replacement was performed. Existing integration coverage and the preceding
live outage evidence do not establish completely transparent terminal/preview
updates. The maintained compatible-replacement procedure remains separate work.

Reproduction: [experiment README](../../scripts/experiments/review-terminal-preview-20261020/README.md).
Measurements: [JSON](terminal-preview-review-20261020.json).
Private logs: `deploy/production/runtime/review-evidence/terminal-preview-20261020/`.
No production source/configuration changes or deployment are included.
