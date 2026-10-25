# Model first-response timeout investigation — October 25, 2026

Status: investigation complete for the local failure mechanism. The upstream
source of the slow first response remains unproven. No application, provider
configuration or deployment was changed, and the user's conversation was not
restarted. The experiments used a local fake upstream, not paid model requests.

## Observed failure

An existing long-running conversation stopped after four consecutive model
requests reached the Worker's response-header deadline. The last preceding Bash
completed successfully. Each failed request took approximately 120 seconds and
the Worker received neither upstream response headers nor body bytes. The local
Model Gateway generated:

```text
HTTP 504: Provider Gateway response headers timed out
```

This is a PiCloud-generated timeout, not evidence that OpenAI returned HTTP 504.
Native generation failure is retained, but Run settlement presents the less
specific `native_task_failed` / `The native task did not complete its accepted input`.

The conversation had no native Compaction task or entry. The latest successful
model usage was 174,645 tokens including output, against a configured 1,000,000
context window and 900,000 automatic-compaction threshold. That is usage from a
completed response, not an exact measurement of the subsequent failed request.
There is no evidence of a context-window overflow or a total-Run-duration limit.

## Timing evidence

The complete affected Run's Worker timing records contain 66 model requests:

| Observation | Result |
| --- | ---: |
| Received response headers | 61 |
| Failed without response headers | 5 |
| Minimum successful header wait | 42.1 s |
| Median successful header wait | 83.8 s |
| 90th percentile successful header wait | 110.1 s |
| Maximum successful header wait | 118.3 s |
| Successful header waits exceeding 90 s | 24 |

One earlier failure recovered; the final four exhausted the observed retries.
These successful timings are censored by the 120-second deadline. The observed
maximum cannot establish how long the failed requests would have taken, or that
a larger timeout would have made them succeed.

## Source and effective configuration

The request path is:

```text
Pi Runner → Worker Model Gateway → CLIProxyAPI
          → provider egress CONNECT relay → configured proxy → provider
```

The relay is downstream of CLIProxyAPI. It is not an extra hop between the Worker
Gateway and CLIProxyAPI.

The running Worker uses these values, also present in the Worker Helm defaults:

| Setting | Value | Actual boundary |
| --- | ---: | --- |
| `modelUpstreamConnectMs` | 120,000 ms | Gateway fetch start through CLIProxyAPI response headers |
| `modelRequestMs` | 150,000 ms | Pi Codex adapter's fetch/header acquisition |
| `modelUpstreamIdleMs` | 300,000 ms | Inactivity after Gateway receives upstream headers |

`packages/supervisor-host/src/model-gateway.ts` arms the first timer before
`fetch()` and clears it when headers arrive. Despite the name, this covers more
than establishing a TCP connection. The idle timer then resets on each received
chunk; it is not a total stream-duration limit. The pinned Pi adapter releases
its header-timeout listener after `fetch()` returns.

CLIProxyAPI source is pinned at
`48549e65b86d17648029190331807b89e7fd65f4`. In that source:

- `sdk/api/handlers/handlers_stream.go` waits for an initial deliverable stream
  payload during bootstrap.
- `sdk/api/handlers/openai/openai_responses_handlers.go` waits for the first
  complete SSE data frame before flushing downstream response headers. This
  preserves an HTTP/JSON error response when bootstrap fails before any data.
- `sdk/api/handlers/stream_forwarder.go` starts its heartbeat only after that
  initial phase. Enabling streaming keepalive therefore does not cover the
  initial no-data wait.
- The additional Codex `stream-bootstrap-buffering` option is explicitly off
  in the deployed configuration. Streaming keepalive is unset/off and provider
  request retries are zero. The extra bootstrap-buffering option is not the
  explanation for this incident.

The provider relay has a bounded connection-establishment timer, but no
120-second established-tunnel timer. Its final correlated tunnel ended with
`client_ended` at the Gateway timeout. That supports caller-initiated closure;
it does not prove TLS completion or progress inside the encrypted connection.

## Isolated characterization

Temporary Go overlay tests exercised the pinned CLIProxyAPI handler with an
in-memory executor and loopback HTTP server. Neither source checkout was modified
by these tests. All three tests passed:

1. An upstream connection and SSE comment were available immediately, while
   the first data frame was withheld for 1.2 seconds. Downstream headers waited
   approximately 1.2 seconds both with keepalive disabled and with a one-second
   keepalive configured.
2. Cancellation before the first data frame left the Gin recorder at status
   200 with zero response bytes. Thus a 200 access-log record alone does not
   establish that the downstream client received a successful response. The
   production failures contain both 200 and 499 access-log records.
3. An immediate `response.created` frame produced downstream headers in about
   1 ms while completion was still blocked. The handler does not inherently
   wait for the whole model response.

Two existing PiCloud Model Gateway tests also passed: a progressing response may
outlive the initial timeout budget, and an established idle response produces a
protocol-visible timeout. These are local transport contracts, not a replay of
the historical upstream incident.

## Remaining uncertainty and proposed follow-up

There were no correlated timings inside CLIProxyAPI for upstream connection,
provider headers and the first meaningful SSE frame. Existing evidence cannot
separate provider queueing/processing from a proxy or network stall. The model
and high effort setting alone do not prove the cause.

The smallest follow-up should retain native retry ownership and existing
transport boundaries:

1. Name the header-wait budget accurately and record bounded, payload-free phase
   timings inside the provider adapter. Distinguish provider headers, first data
   frame and downstream flush rather than calling all of them connection time.
2. Evaluate a larger first-response budget against measured traffic. A
   240-second Gateway budget and 270-second Pi budget are a possible bounded
   trial within the existing 300-second validation bound, not a proven fix.
   Keep cancellation and the separate stream-idle budget intact.
3. Preserve the specific safe native model failure in Run/UI error presentation
   instead of reducing this incident to an unspecified task failure.

Simply adding startup heartbeat bytes would change HTTP error semantics and
could disguise a stalled model request. It is not the proposed repair. No timeout
change, provider fork change or additional retry layer was implemented by this
investigation.

Private logs and fixtures remain under the ignored deployment runtime directory;
no conversation transcript, request payload, credential or user image is included
in this report.
