# ADR-0282: Native model WebSocket continuation through the Worker gateway

Status: deployed and end-to-end accepted as `continuation-5f-final`, schema 202,
Helm 115, 2026-10-27. The owner approved reducing
repeated image transmission using the native Codex/Pi incremental transport.

## Evidence and choice

The [latency investigation](../reports/live-tail-and-model-latency-20261027.md)
finds 25 retained model images / 106.1 MiB base64 repeatedly sent over the current
HTTP route. Cached token accounting does not eliminate request upload. Adopt
the pinned Pi 1.0 Codex provider's `auto` WebSocket continuation instead of writing
another history/delta engine. It already compares the complete request prefix,
chains the previous response, replays full input when the prefix changes, handles
missing continuation and falls back to SSE. The deployed pinned CLIProxyAPI has
the matching native WebSocket route. Reuse the existing pinned `ws` 8.21.1 Node
transport (MIT), not a new service/cache/queue or provider SDK.

Primary evidence: [OpenAI WebSocket guide](https://developers.openai.com/api/docs/guides/websocket-mode),
the locally pinned Pi `api/openai-codex-responses` and CLIProxyAPI
`48549e65b86d17648029190331807b89e7fd65f4` WebSocket implementation, plus
[ws](https://github.com/websockets/ws/tree/8.21.1).

CLIProxyAPI account metadata must also enable `websockets: true`. Its downstream
WebSocket interface can otherwise expand delta input and send full HTTP requests
upstream. The maintained publication operator applies this transport preference
through the provider's management API, preserving tokens, account disabled state
and non-Codex accounts. Provider metadata remains the sole authority for that
setting. Reapply the operator after importing Codex accounts; no per-request
management query or separate account configuration store is introduced.

## Boundary and protocol

Pi remains the sole request-context/delta owner. The trusted Models port uses a
Node WebSocket adapter for Pi's standard runtime constructor, scoped through
AsyncLocalStorage. It supplies the existing native provider authentication
headers and wraps each outbound native request in a PiCloud-owned text frame:
a JSON `{ protocolVersion: 1, sampling }` header (at most 4 KiB), one LF, then the
exact serialized native request. This avoids re-escaping a large JSON/image body.
Sampling carries the existing Step sequence/digest/attempt. It is outside the provider request so changing it neither
invalidates Pi's prefix comparison nor reaches the model/provider. A persistent
connection's opening headers must never be reused as later requests' Step identity.

The local Model Gateway authenticates the existing Run capability on upgrade
and rechecks it on each frame. It validates the model/Fast binding and atomically
reserves the existing request budget before forwarding. No per-frame PG read.
One request is active per connection; native child Conversations and context
maintenance use separate incarnation-scoped cache identities. They keep the
existing fair model permits and share only the existing root request budget.
The gateway forwards native provider frames unchanged, with bounded payloads and
backpressure, and retains no transcript or previous-response ledger.

Close both sockets when ownership is revoked, the client disconnects or the
gateway retires. Run cleanup closes native cache entries and their large input
references. Native Models owns valid-event inactivity and semantic retries;
the gateway adds only a connection-establishment bound. A lost reference or
connection can require a complete context resend. It never replays a Tool or
commits a partial Tool call. DeepSeek keeps its current HTTP adapter.

Pi's native fallback policy can retain SSE for the rest of a cache scope after a
WebSocket transport failure. Normal Run cleanup discards that scope; a new owner
can try WebSocket again. This change does not add a competing reconnect/retry loop.
Keep existing HTTP zstd and upstream WebSocket compression behavior. The pinned
proxy explicitly disables outgoing permessage-deflate to avoid documented flate
tail-validation failures; forcing it back on is outside this verified change.

Connections and provider context caches are disposable. PG/Kafka/native storage,
attachment identity and Cube execution ownership do not change. Payload-free
timings record transport, request/response bytes, incremental/full selection,
connection setup and first provider frame; no prompt/image/auth contents or raw
provider errors enter telemetry. Physical HTTP fallback attempts remain counted.
Gateway write timing measures delivery to CLIProxyAPI, not completion of the
proxy-to-provider upload; first-frame delay still includes that external path.

This changes the private Runner-to-Gateway transport and adds no PG migration.
Use the maintained matched release after writer/resource drain, retaining user
intent and Workspace bytes. HTTP remains a supported native transport fallback,
not an old PiCloud wire-version compatibility branch.

## Acceptance

Verify actual Pi provider + gateway + fake WebSocket upstream: the second Tool
round carries only the new result, image bytes are absent, and response content
stays correct. Cover concurrent Conversations/maintenance, context replacement,
missing reference, disconnect before/after output, Stop/revocation, budget limits,
invalid frames, size/backpressure bounds and cleanup. No partial local Tool call
becomes committed. Exercise actual subscription Luna continuation separately,
then the deployed Worker/Cube path with retained image input and one reconnect.
The first request and reconnect remain full-input cases; do not claim that every
request or provider can avoid retransmission.

Acceptance verifies account eligibility and the isolated provider Pod's outbound
byte count, not only the Worker-to-proxy frame size. The deployed two-Run fixture
uses different Workers: each initial request is about 3.11 MB, each subsequent
delta 19.8 KB, and total provider transmission about 3.45 MB per three-request Run.
See the [delivery report](../reports/model-continuation-delivery-20261027.md).
