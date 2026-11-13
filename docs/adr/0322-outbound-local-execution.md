# ADR-0322: Outbound local execution with the existing destination contract

Date: 2026-11-13. Status: accepted; implementation in progress. Issue: #38.

The owner authorizes local execution with cloud-only Pi loops. The first
supported local environment is explicit Linux execution in Bubblewrap 0.9.0;
it is not a fallback for KVM or a claim of equivalent VM isolation. The fixed
Guest tools run in a separate persistent user/PID/mount namespace with only an
explicit project directory writable, a temporary filesystem and required
read-only runtime files. No host home, Docker socket or platform credentials
are mounted. Absence of this tested boundary fails startup. Namespace lifetime
preserves detached application processes until the user stops the local service.

## Adopt before build

OpenSSH remote forwarding is established and supports outbound connections
([manual](https://man.openbsd.org/ssh.1)). Integrating it here would add SSH
account/key administration and forwarded listener management to device admission.
Use the already-pinned MIT `ws` 8.21.1 and `@fastify/websocket` 11.3.0 instead,
through the existing HTTPS ingress. [Fastify's maintained implementation](https://github.com/fastify/fastify-websocket)
owns WebSocket framing and lifecycle. [Bubblewrap](https://github.com/containers/bubblewrap)
owns Linux namespace setup; the launcher supplies an explicit policy. No new
event broker, scheduler or provider source fork is necessary.

## Roles and identity

The device link is a narrow transport process. A user-side connector initiates
an authenticated WebSocket; an operator provisions one credential scoped to the
device ID. The cloud side receives ordinary private Executor HTTP requests and
relays only inspect/submit/cancel/revoke operations over the established link.
The device side forwards them to its fixed local receiver with a distinct local
credential. Neither device receives the cloud management credential or PG/Kafka
access. The gateway has no Session writer, consumer, resource lease or scheduler.
PG still owns target organization, binding and generation. Gateway credentials
permit connectivity, not a transfer of device ownership.

A connection is disposable. Pending transport requests are bounded, time out,
and fail uncertain when the link disappears; they are never queued for replay.
Reconnect transports new commands only. The receiver's original boot, operation
identity and ordered-position admission remain authoritative for duplicate
suppression. Final results bypass the link through their original scoped HTTPS
completion destination, so disconnect does not erase a completed operation or
reroute its reply to a new Worker.

Extract the shared fixed receiver admission/cancellation from Android rather
than copying its state machine. Linux target tools use explicit `local_*` names
and capabilities; ordinary file/shell output is reduced at source by the fixed
Pi tool implementation. Long commands retain their original bounded operation
and reply deadlines across Worker replacement. Local directories are mounted as
`/workspace`; selecting a target does not copy cloud Workspace bytes.

Registration verifies the receiver's kind, identity and capabilities. Only idle
Sessions may change target; child Agents do not implicitly inherit a physical
device. The device stays outside managed VM creation/expiry/destruction and
compute service billing. Closing chat disconnects only that reader. Stopping the
executor is a separate user action and can interrupt local work.

## Acceptance and exit

Verify native file/shell/image behavior, background process lifetime, exact
cancellation, disconnected/replaced receiver admission, original-result delivery
after Worker replacement, source truncation, scoped credentials and device
ownership. Run a real local Linux target against the cloud Session path and an
independent chat client. Check clean-checkout startup and document the Linux-only
boundary. Removing a target requires existing binding closure; never interpret
a disconnected gateway as proof to delete user files or release managed resources.
