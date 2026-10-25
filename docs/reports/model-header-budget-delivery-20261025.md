# Model header-wait policy and observability follow-up — October 25, 2026

The owner authorized a longer first-response wait and asked how to improve
diagnosis. The [preceding investigation](model-first-response-investigation-20261025.md)
remains the historical evidence; it did not prove the cause of upstream latency.

## Policy change

Both the standalone Worker chart and platform chart now configure:

| Boundary | Previous | New |
| --- | ---: | ---: |
| Worker Gateway through upstream response headers | 120 s | 240 s |
| Pi's enclosing response-header wait | 150 s | 270 s |
| Established stream inactivity | 300 s | 300 s |

The existing binaries accept these values. No Agent duration limit, new retry
layer, protocol change or provider heartbeat is introduced. The header timeout
still bounds requests that never start, while Stop/ownership loss can cancel
earlier. More time before a retry is an intentional cost when the upstream is
actually stuck; this policy does not guarantee completion.

The [ADR-0263 amendment](../adr/0263-model-response-and-work-lifetimes.md#october-25-header-wait-policy-adjustment)
records this bounded configuration publication. All image artifacts and their
provenance remain unchanged. Helm persists the paired override, and chart
defaults preserve it for future full publication. No application image rebuild,
migration hook, Cube restart or Workspace release is needed.

## Validation and publication

Source verification passes:

- `npm run runtime-policy:check`;
- `npm run helm:check`, including cross-service policy and self-hosted rendering;
- 25 Worker configuration / Model Gateway tests, including cancellation and
  progressing/idle stream behavior;
- formatting, documentation checks and `git diff --check`.

The complete installed/rendered manifest comparison permits exactly two Worker
environment changes. Preflight confirms zero active Runs. Publication uses the
existing release lock, Helm without hooks, and normal StatefulSet replacement
with the existing graceful Worker drain/fencing contract.

Deployed as `header-budget-b8e009fa`, policy source `b8e009fa`, Helm revision
101 → 102. Both Worker Pods are ready with 240,000/270,000/300,000 ms values.
All unrelated Pod identities and all component image identities are retained.
The deployment combination records the new policy revision while preserving each
component's original image source and scan provenance.

A newly created private fixture completed a real GPT-6 Luna conversation in
4.1 seconds with the expected answer. Its native Run completed normally; Session,
Workspace/Volume and tenant cleanup are confirmed. The original conversation was
not used as a probe. This verifies the published configuration and ordinary
model path, not that every historical 120-second timeout would now succeed.

## Proposed observability slice — not implemented

Collect timings at the provider adapter, where the upstream connection and SSE
are actually visible. Worker Gateway timings alone combine all of these phases.

For each upstream attempt, carry one diagnostic request identifier through the
Worker and CLIProxyAPI. Record monotonic elapsed times for:

1. Provider request preparation and account selection completed.
2. Proxy/TCP connection established, then TLS handshake completed.
3. Request headers/body write completed.
4. Upstream response headers received.
5. First response body bytes and first complete, valid SSE data event received.
6. First downstream data flush, followed by completion, cancellation or failure.

Treat an SSE comment heartbeat separately from a meaningful provider event.
Retain each stage at most once per attempt, plus its terminal observation. Log
whether a connection was reused and distinguish attempts when an account changes.
Use existing operational logs, not Kafka history, PG rows or a new telemetry
service. Only bounded timing/status/event-kind metadata and permitted provider
request identifiers belong here; prompts, body contents, images and credentials
do not. Observations must not delay or decide native execution.

Go's standard [HTTP client tracing](https://pkg.go.dev/net/http/httptrace#ClientTrace)
provides connection, TLS, request-write and response-header hooks. However, this
pinned CLIProxyAPI uses a custom `utlsRoundTripper` for the Codex route:
`internal/runtime/executor/helps/utls_client.go` calls its proxy dialer and TLS
handshake directly. A generic tracing wrapper cannot be assumed to cover those
operations. Add bounded observations at those existing boundaries, alongside the
request/body handling in `codex_executor_stream.go` and the initial downstream
flush in `openai_responses_handlers.go`; preserve the current transport behavior.
The existing usage reporter's aggregate latency/TTFT is not a substitute for
these stages.

This would distinguish a slow connect/handshake, a slow upload, waiting for
upstream response headers, a quiet response stream, and delayed local forwarding.
For example, first upstream data at 3 seconds but first downstream flush at
100 seconds points to a local forwarding delay. A completed request write followed
by 100 seconds without response narrows the wait to the upstream path; it does
not prove whether the provider queued or computed during that period.

Service-side queueing versus model processing requires trustworthy timing from
the provider. Without that evidence, report the interval as waiting for upstream
response rather than inventing a queue or thinking measurement. Low-overhead
request correlation and these bounded stage logs are sufficient for the first
slice; a separate trace backend is not required.
