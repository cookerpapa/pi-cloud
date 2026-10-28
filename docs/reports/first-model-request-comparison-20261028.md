# First model request: PiCloud, native Pi and Codex

Status: source comparison and isolated live measurements completed, 2026-10-28.
This is an investigation, not a claim that the large-upload problem is repaired.

## Observed slow path

Three recent Runs in the reported long conversation were inspected read-only.
The model was GPT-6.1 Sol with xhigh effort. No user input or image was resubmitted.

| Measurement | Sample A | Sample B | Sample C |
|---|---:|---:|---:|
| PG admission to Worker start | 90 ms | 74 ms | 68 ms |
| Worker start to initial Gateway request | 4.89 s | 5.78 s | 5.30 s |
| First WebSocket request | 36.81 MB | 37.33 MB | 42.71 MB |
| WebSocket lifetime with zero response bytes | 116.72 s | 95.45 s | 96.65 s |
| Local Gateway connection to CLIProxyAPI | 16.47 ms | 7.99 ms | 3.18 ms |
| Local request write completion | 393 ms | 445 ms | 571 ms |
| HTTP fallback to first response byte | 81.52 s | 156.27 s | 155.06 s |
| Overall model invocation to first native frame | 199.77 s | 253.59 s | 253.39 s |
| Overall model invocation to first visible text | 223.54 s | 299.13 s | 348.27 s |

The local write measurement ends at CLIProxyAPI. It does not measure completion
of the Windows proxy or provider upload. CLIProxyAPI logs align these WebSocket
failures with `send_error` and TCP resets while writing toward provider egress.
The host relay records `upstream_error` against its configured upstream proxy;
the Worker sees abnormal closure 1006 and Pi falls back to HTTP. The maintained
relay has no established-tunnel wall-clock expiry. These observations locate the
failure downstream of the local Gateway, but do not distinguish the Windows proxy,
its outbound node, and the remote endpoint as the initiating cause of the reset.

The successful HTTP requests still spend substantial time before their first
frame, then additional time before visible text. Local logs cannot separately
attribute that interval to external upload, provider queuing, prefill and reasoning.
The observed slow path is not explained by PG queue admission or a millisecond
Gateway connection alone.

## Compared implementations

Sources: PiCloud at `d116cb21`, pinned Pi AI/Durable 1.0.0, Codex CLI 0.164.0 and
its official `rust-v0.164.0` source, plus the deployed CLIProxyAPI
`48549e65b86d17648029190331807b89e7fd65f4`.
The separate local Codex checkout has a user modification; it was not changed.

| Behavior | Native Pi provider | Current PiCloud | Codex 0.164.0 |
|---|---|---|---|
| Initial input | Full effective context | Full effective context after cloud preparation | Full effective input, possibly following a small prewarm |
| Later input | Native previous-response prefix comparison | Same native implementation within its scope | Cached previous-response continuation |
| Connection lifetime | Caller-supplied native session/cache scope | Writer incarnation + Conversation + purpose; closed at Run cleanup | Session client retains connection state across compatible turns; resets on auth-owner change |
| Prewarm | No public preconnect/prewarm entry point in the pinned provider interface | No additional speculative model request | Best-effort WebSocket prewarm with `generate=false` |
| Failure fallback | Native WebSocket-to-HTTP policy | Reuses that policy | Its own budgeted WebSocket/HTTP fallback |
| Cache hint | Derived from the supplied native session ID | Consequently includes the writer incarnation | Usually derived from the stable logical Codex session |

The [Codex client source](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/client.rs)
separates turn clients from retained session connection state. Its prewarm is
observable in the live comparison below. Native Pi's cache and fallback are not
equivalent to durable storage or execution authority.

OpenAI documents connection-local state for WebSocket continuation and full-input
recovery when a non-stored response reference is unavailable.
[Official WebSocket guidance](https://developers.openai.com/api/docs/guides/websocket-mode#how-continuation-works).
Prompt caching is also distinct from avoiding request upload.
[Official caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching).

The proxy's `applyCodexPromptCacheHeadersWithContext` reads a request's
`prompt_cache_key` and uses it for upstream session/conversation cache headers.
Keeping that hint separate from an execution-bound connection identity is a
concrete improvement candidate. It has not been proved to solve the observed
TCP resets, and this report does not claim a measured cache-hit improvement.

The pinned proxy negotiates permessage-deflate but explicitly disables outbound
WebSocket compression because of its documented flate-tail compatibility issue.
That differs from assuming every large WebSocket upload is compressed. Changing
it requires its own upstream compatibility evidence, not a speculative toggle.

## Isolated real-model comparison

All clients used the installed CLIProxyAPI route, GPT-6 Luna and low effort.
The native Pi and PiCloud cases used the same Pi provider and input; the PiCloud
case additionally exercised ScopedDurableModels and the actual local Model Gateway.
Codex ran its real app-server in an isolated, disposable container with a synthetic
Workspace. A loopback test bridge supplied the proxy credential outside that
container and recorded timing/size metadata. No user conversation was mutated.

| Text-only request | Native Pi | PiCloud model path | Codex CLI |
|---|---:|---:|---:|
| First completed response | 6.50 s | 2.82 s | 3.56 s |
| Second completed response | 1.79 s | 1.23 s | 1.91 s |

These are single sequential samples, not statistical evidence of a ranking.
All six returned the expected marker and used incremental continuation for the
second request. Codex first sent a 1,394-byte prewarm. Its ordinary initial input
also included its own instruction/tool definitions, so it is not byte-identical
to the minimal Pi fixture. Codex process/thread setup took about 2.19 s separately.
The first driver reported a synchronous Docker-stop timeout after all measurements;
absence of its container was confirmed, and cleanup was made asynchronous for the
subsequent probe. The initial failure remains in the private evidence.

For the large test, both clients received the same ten synthetic 1024×1024 PNGs
and the same request for a short marker. Both remained on GPT-6 Luna/low:

| Large cold request | Native Pi | Codex CLI |
|---|---:|---:|
| WebSocket request size | 42,033,384 B | 42,067,995 B |
| Failed WebSocket attempt | 80.50 s | 76.35 s |
| HTTP fallback to first native frame | 98.40 s | 119.60 s |
| Overall completed response | 185.76 s | 202.32 s |
| Effective input tokens | 12,325 | 18,991 |

Both fell back to HTTP and eventually returned the expected marker. Codex also
performed a small successful prewarm, which did not prevent its large send from
failing. Its extra built-in context accounts for different token counts. This
is a paired failure reproduction, not a benchmark of the proprietary desktop
application or its direct subscription network route. One sample per client,
account selection and network variability limit any relative-speed inference.

## Consequences for follow-up work

Do not lower native wait budgets or silently remove historical images to make a
small benchmark look faster. Do not reuse old Worker grants or introduce a second
provider-context authority to preserve sockets across ownership changes.

The smallest candidate code improvement is a stable tenant/conversation/purpose
cache hint, separately from the writer-scoped connection cache. Verify headers,
cache-token observations, cancellation and ownership revocation before claiming
benefit. Cross-Run socket reuse and prewarm would be larger lifecycle changes.
Large-message upload failures need an equivalent provider-route test when the
proxy path changes; prewarm alone did not eliminate them here. An upstream write
reset should not be described as PG slowness or a PiCloud-only Agent-loop failure.

Private evidence:
`deploy/production/runtime/work-evidence/main-latency-forks-20261028/latency/`.
It contains source snapshots, sanitized timing summaries, isolated driver code,
the retained cleanup failure and completed large-input probe. Provider credentials,
user transcripts and images are excluded from this public report.
