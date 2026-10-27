# Live-tail presentation and provider latency investigation

Status: source and targeted acceptance pass; Web-only publication pending.

## Presentation findings and repair

The owner observed a return-to-latest indicator even after scrolling to the
bottom, and adjacent Bash/Edit/Bash appearing in separate groups until reopening
the conversation. Both have concrete frontend causes.

Browsing freezes a bounded history window. The old scroll handler fetched newer
pages but never rejoined the live view after reaching the last one. Edge checks
now join live only after known canonical pages are exhausted, including an empty
forward-page response. A settling guard cannot consume the only bottom-scroll
event. Remaining above the bottom preserves the reader's anchor, and a nonempty
forward page must be read before joining live. No periodic history polling or
unbounded transcript fetch is added.

Snapshot items had a presentation page key; new SSE items did not. The grouping
rule therefore split otherwise adjacent Tools at the snapshot/live boundary.
Live items now continue their Turn's last snapshot page, and Tool preparation
replacement preserves its page/cursor metadata. Actual historical page boundaries,
human/text/image boundaries and the 12-Tool group limit remain. This changes no
execution, history or public protocol schema.

Acceptance includes snapshot + preparing/start/final events compared with a
fresh canonical snapshot; distinct pages and group limits; and production React
components in real Chrome. The old revision fails manual bottom return without
a second gesture. The fixed version passes all 20 layout scenarios, including
empty-tail confirmation, reading a nonempty newer page, following subsequent
output, resize, Tool expansion, window trimming and historical reading anchors.
The 8 MiB actual PG/API/SSE/browser composition also passes, including automatic
older-edge loading, bounded eviction, bookmarks and 600 live outputs while reading.

ADR-0267 explicitly includes the browser-only `session-view.ts` reducer in the
Web publication scope. API client, protocol, dependencies, provider and backend
changes still require their existing release scopes. Publication must retain the
running Worker, Session ownership, Workspace allocation and configuration.

## Model findings — separate from the UI repair

Content-free Worker timings sampled at 05:53 UTC cover 26 completed transport
attempts in the active long conversation. Local request preparation/forwarding
has a median of 824 ms. Four attempts receive no response headers/bytes and end
at approximately 298 seconds under the native 300-second valid-event deadline.
Three return HTTP 500; CLIProxyAPI also records TLS-handshake EOF failures.
The 19 successful requests have a median header wait of 213.6 seconds (range
113.8–267.6 seconds).
Transport cancellation after a native `response.completed` is normal and is not
counted as another model failure.

The selected model is GPT-6.1 Sol at xhigh. This is not a controlled comparison
with the owner's Codex model, context or service tier. Current Codex documentation
also specifies a 300,000 ms default stream idle timeout; raising PiCloud's
timeout alone would not explain or fix these stalls.

One isolated 164-byte GPT-6 Luna/low request through the same installed proxy
receives headers in 2.80 seconds and text in 3.40 seconds, completing successfully.
This rules out an invariant multi-minute proxy delay for every request; it is not
a controlled size-only comparison with Sol/xhigh and does not establish causality.

Using the pinned Pi context derivation read-only against native entries finds
25 images in the active context, totaling 83,419,564 raw bytes (79.6 MiB).
There is no compaction head or context edit. Base64 for those images alone is
111,226,124 bytes (106.1 MiB); other context adds roughly 2 MiB before provider
translation. This is a reconstructed size estimate, not an upstream packet capture.

The current Worker explicitly uses SSE. The pinned Pi provider submits full
context and can compress the local request with zstd; attachment decoding restores
the original stored model-image bytes. The deployed CLIProxyAPI source at
`48549e65b86d17648029190331807b89e7fd65f4` removes `previous_response_id` on its
HTTP path, translates the full JSON, and sends that raw JSON upstream. Its Codex
HTTP transport creates a new upstream connection per request. Cached input token
accounting does not avoid sending those request bytes.

The local official Codex source at `40e5de94e95769536843afb44e3d82812a467d49`
contains HTTP zstd request compression and connection-scoped incremental WebSocket
continuation when the previous response/input prefix is reusable. These are
capabilities, not proof of which transport the owner's desktop currently uses.

The repeated large image body is a concrete efficiency problem and TLS EOF is a
confirmed transport failure. Existing logs cannot divide the 200-second wait
between outbound upload, provider queue/processing and proxy forwarding. Do not
claim all latency comes from CLIProxyAPI or from model reasoning. Preserve the
active conversation; do not force compaction, delete historical images, reduce
reasoning or replace its provider connection as part of a display repair.

Next measurement should record payload-free request size and dial/TLS/body-written/
upstream-first-event/downstream-flush timestamps in the provider adapter. A bounded
transport improvement should evaluate supported upstream compression and then
connection-scoped incremental continuation, retaining native retry and full-context
reconnect fallback. Neither may introduce a second durable conversation authority.
Treat automatic removal/downsampling of historical visual context as a separate
model-context decision, not an invisible presentation optimization.

Evidence and temporary read-only diagnostics are private under
`deploy/production/runtime/release-evidence/session-ui-provider-20261027/`.

Sources: [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex client source](https://github.com/openai/codex/blob/40e5de94e95769536843afb44e3d82812a467d49/codex-rs/core/src/client.rs),
[Codex compression contract](https://github.com/openai/codex/blob/40e5de94e95769536843afb44e3d82812a467d49/codex-rs/core/tests/suite/request_compression.rs).
