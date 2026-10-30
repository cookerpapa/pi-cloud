# ADR-0289: Provider-owned model continuation

Status: deployed. Base matched release `provider-continuation-20261030`, provider
configuration repair `provider-continuation-config-20261030`, and send-once
refinement `provider-send-once2-20261031`; schema remains 205. The owner approved
the researched proxy-side proposal. This supersedes ADR-0282's Worker-owned
connection/delta path, not Pi's semantic context, native retry or storage ownership.
See the [delivery report](../reports/provider-continuation-20261030.md) for passed
checks and the owner-deferred large cold-upload gate.

Publication amendment: deployed Helm values exposed scientific notation in large
integer environment values, which strict Go configuration rejected. Render these
provider values explicitly as decimal integers and initialize/validate the cache
at server construction, before readiness. The maintained provider-only release
may carry the explicitly listed provider adapter sources and this template, with
whole-manifest comparison allowing only the provider image and numerically
identical decimal normalization of the four model-transport environment values.
It cannot change those values, any other environment, replicas, volumes or other
workloads. Hash all provider build inputs, not only its Dockerfile. Test rejection
of changed limits and unrelated manifests before using this narrower repair path.

Transport retry amendment (2026-10-31): real cold-image probes exposed CPA's
additional reconnect/resend inside its WebSocket executor before the adapter's
HTTP fallback. Adapter-owned sessions return a request-scoped send failure instead
of repeating that upload or rotating credentials. The adapter may then make its
single pre-output HTTP fallback. A failed/cancelled HTTP attempt retains only its
bounded fallback preference, never response/input state, so native Pi retries do
not repeat the broken WebSocket upload. The owner explicitly deferred further
131 MiB real-provider probes; verify this repair with local deterministic send
failures and ordinary-size live requests.

## Problem and adoption evidence

Normal Run settlement releases the Worker-local model grant and native socket.
Different Workers cannot reuse that socket. A retained visual context also exceeded
the local 128 MiB decoded request limit; zstd's size exception was incorrectly
reported as invalid encoding. Token compaction and transport bytes are different
budgets. Retain the owner's existing native-token/manual-compaction policy.

The fixed Pi AI 1.0 provider owns an unexported connection cache; it provides no
public cross-process cache transfer. Its HTTP/SSE adapter emits full effective
context. Use that public adapter without modifying Pi core.

Research checked the deployed CLIProxyAPI `48549e65b86d17648029190331807b89e7fd65f4`
and current upstream, LiteLLM, Bifrost, GPT-Load's embedded CPA facade and
claude-cursor-proxy. CLIProxyAPI's native downstream WebSocket handler closes its
upstream execution session when the downstream disconnects. Bifrost's client-bound
Session similarly closes its pinned upstream. LiteLLM's deployment affinity is
not a promise of the same live upstream socket after reconnect. Replacing the
gateway would add account/protocol migration without establishing this requirement.

The MIT-licensed claude-cursor-proxy at
`dcd8347fcfc5ba0fe8b90171d16c12a59ebe9413` demonstrates logical-session continuation
with a request-prefix check and retained socket, but its translated protocol and
2 MB per-session transcript budget do not fit PiCloud's native image requests.
GPT-Load's MIT CPA facade demonstrates bounded reuse of the pinned executor and
explicit cancellation rather than a second account scheduler. Adopt the existing
CPA execution and credential machinery; retain only the bounded PiCloud transport
adapter. No additional daemon, broker, store or account pool is added.

Sources:
- [OpenAI connection-local continuation](https://developers.openai.com/api/docs/guides/websocket-mode#how-continuation-works)
- [CLIProxyAPI downstream lifetime](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/api/handlers/openai/openai_responses_websocket.go)
- [Bifrost Session lifetime](https://github.com/maximhq/bifrost/blob/dev/transports/bifrost-http/websocket/session.go)
- [LiteLLM deployment affinity](https://docs.litellm.ai/docs/response_api#load-balancing-with-session-continuity)
- [CPA embedded facade](https://github.com/tbphp/gpt-load/blob/main/third_party/cpaembedded/README.md)
- [Proxy continuation comparison](https://github.com/YeautyYE/claude-cursor-proxy/blob/dcd8347fcfc5ba0fe8b90171d16c12a59ebe9413/src/providers/codex/continuation.rs)

## Data flow and authority

Worker Pi builds full effective context through its public HTTP/SSE provider.
The existing Worker-local gateway validates the current Run grant/model/budget,
derives an opaque tenant/physical-Session/Conversation/purpose transport key and
forwards to a private authenticated CPA HTTP route. The in-process route uses
CPA's existing streaming auth manager and Codex WebSocket executor. It wraps
native provider events in SSE for the Worker. DeepSeek keeps its native HTTP path.

Normal HTTP completion does not end a completed upstream session. A later Run,
including on a different Worker, can reuse the session if all request properties
and the completed transcript prefix match. The adapter alone selects upstream
full/delta input. The obsolete Worker WebSocket envelope/cache is removed at the
matched cutover. The internal network still carries full context; this change
claims savings only on proxy-to-provider traffic.

Retained state is disposable: upstream session/account identity, completed response
ID, parameter and ordered input fingerprints, and bounded replay-comparison data.
Do not keep historical image base64 copies in the idle cache. Do not reconstruct
or invent context from a cache hit: the current full request is authoritative.
Only a successful terminal response may advance the baseline. If Worker settlement
failed, its next full context will not match that baseline, so start afresh.
History edits, Fork, compaction and model/tool changes must not accidentally append
to a different prefix. Unknown replay shapes conservatively miss the cache.

Run grants retain their current release/Stop/lease-loss behavior; no grant survives
because a transport cache exists. Active downstream cancellation closes the
corresponding upstream session. A completed, idle session has no running Agent or
execution permit. Late cleanup uses object identity and cannot erase a successor.
One request uses a cache entry at a time; child Conversations and compaction are
independent. Account revocation/rotation invalidates continuation. No per-request
PG lookup, Worker affinity, execution lease or durable cache receipt is added.

Bound idle residency, entry count and comparison metadata. The adapter uses CPA's
public auth-manager/streaming executor port in the existing process. A scoped
executor patch removes CPA's competing five-minute reader deadline only for
adapter-created `picloud-model-` sessions: its cache owns idle expiry and Worker
HTTP cancellation/event inactivity owns active waits. Ordinary CPA sessions retain
their existing reader deadline. Verify real reuse after more than five idle minutes.

Idle expiry is a
transport resource policy, not a whole-Run deadline. OpenAI may invalidate state
earlier; store=false has no persistent fallback and public sockets last at most
60 minutes. Missing continuation before generation may reset once to the supplied
full request. A pre-output WebSocket transport failure may fall back once to HTTP, matching
the existing native Pi policy; five minutes of disposable HTTP fallback avoids
repeating the same failing upload on each Step. No after-output or generic
provider-error replay is added; native Pi remains the semantic retry owner. Tools are never replayed by
this adapter. A process restart is a cold cache and needs no database recovery.

## Large requests and observations

Use one configurable decoded request-size contract on Worker/provider adapters,
with a 256 MiB initial default and a separate 512 MiB retained-upload budget.
Reserve actual compressed/decoded chunks before retaining them, not a maximum
request reservation that unnecessarily limits concurrent small requests.
Validate real memory/parallel behavior before publication. Preserve zstd HTTP
compression. Classify decoded-size overflow as request-too-large, malformed
compression separately, and expose a useful failure encouraging manual /compact.
Do not silently drop images, change their quality or force compaction.

Record transport key hash, sampling identity, full/upstream bytes, hit/miss reason,
connection reuse and terminal status. Never log request bodies, images, provider
credentials or raw sensitive errors. Local bytes and actual provider transmission
are different measurements and must be reported separately.

## Acceptance and rollout

Test real native Pi payloads against fake upstream: text, reasoning, parallel Tools,
images and hosted output; parameter/prefix changes; two independent clients/Workers;
overlap, cancellation, late completion, expiry, missing response and account change.
Prove >128 MiB valid zstd input passes the new bound, true oversize is classified,
malformed bodies do not reach upstream, and concurrent uploads remain bounded.
Prove stopped/failed native tasks still settle correctly and no partial local Tool
call becomes durable. Measure memory and end-to-end bytes rather than cache tokens.

Pin the existing CPA source and apply the adapter through the maintained provider
build. No schema change. Commit/push source, prepare a clean matched release,
drain writers and preserve accounts, configuration, native history, images and
Workspace bytes. Run isolated real Luna cross-Worker/image/Tool acceptance and
relevant recovery checks. A failed gate remains explicit; don't count source-only
or fake-provider success as live acceptance. Rollback is a matched artifact/config
rollback after drain; caches are discarded and full input remains available.
