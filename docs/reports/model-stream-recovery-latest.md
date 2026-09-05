# Model stream recovery — 2026-09-05

Tested base: `6b9952ae` plus this change's working tree. Deployed CLIProxyAPI
fork: `48549e65`. Topology: WSL, two Pi Workers, PostgreSQL, three Kafka brokers,
Cube KVM and the operator's existing HTTP proxy. No credential or proxy-route
change was used to obtain passing results.

## Original failure and attribution limit

The user Run completed one directory-inspection Bash and then failed during
the next GPT-5.6 Sol sampling with:

`Codex error: stream error: stream disconnected before completion: stream closed before response.completed`

The original relay admitted that connection at 02:41:18.422 UTC and recorded
closure at 02:42:36.148 UTC (77,727 ms). Pi's pinned retry classifier returned
false for the exact error; consequently PiCloud never entered its configured
two-retry policy. The development machine remained running and no write Tool
had been executed.

The relay contained an unrelated 180,000-ms hard connection lifetime. This is
a real long-stream defect, but it cannot explain this 77.7-second failure.
The old `client_closed` log did not distinguish an upstream HTTP-body EOF from
an explicit provider error or a read error followed by client cleanup.
Original response/scanner evidence was not retained. It is therefore not
possible to attribute that historical disconnect conclusively to OpenAI or the
intermediate network. Successful later calls do not prove either attribution.

## Changes

- Extend Pi's classification for known premature Responses endings; preserve
  the existing bounded retry/backoff and cancellation authority.
- Retry only model sampling. Keep completed Tool results and never execute
  Tool arguments from an interrupted response. Reset retry numbering after a
  successful Tool-producing sampling, before the next logical Step.
- Retain already-visible text in the existing non-executable interrupted-prefix
  fact before retry, preserving it through later Session restoration.
- Surface a bounded stream-interruption message instead of generic model failure.
- Remove the CONNECT tunnel's wall-clock kill timer. Preserve connection setup
  timeout, TCP keepalive, model streaming-idle timeout and Turn cancellation.
- Audit the initiating TCP half-close. CLIProxyAPI logs a provider error event,
  clean premature EOF, unexpected EOF, HTTP/2 reset, read error or cancellation,
  along with HTTP version, upstream request ID and duration. No body or credential
  logging is enabled.

Official [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
documents five stream retries by default and a 300-second SSE idle timeout.
The inspected local Codex source also hides the first WebSocket retry notice in
release builds and supports transport fallback. These mechanisms explain why
perceived continuity does not establish that a connection never failed; they
do not prove that this user's local Codex actually retried during this incident.
PiCloud keeps its existing two model retries rather than copying every Codex
transport mechanism.

## Verification

218 related TypeScript tests passed, along with repository typechecks,
formatting/documentation checks and affected container image builds.

Deterministic coverage includes actual HTTP socket interruption through Pi's
provider adapter, exact Codex error text, two failed model Steps separated by
successful Tools, no replay of completed effects, no execution of partial Tool
calls, retry exhaustion, permanent credential/quota errors, cancellation during
backoff, prefix restoration, and an echo tunnel surviving 181 seconds of fake
clock advancement. The latter is a timer regression test, not a real 181-second
network stability claim. CLIProxyAPI diagnostic tests and compilation passed.

The real-model [Snake acceptance](snake-preview-acceptance-latest.json) explicitly
selected GPT-5.6 Sol, reasoning off, Fast disabled. It completed 14 Tools in
203,674 ms, with first assistant text at 3,548 ms. Native usage totaled 34,270
input, 9,820 output and 169,984 cache-read tokens. Browser preparation/refresh,
authenticated host Preview, game start, movement, pause and reset passed.

Two additional model-only calls bypassed Agent orchestration but traversed the
same CLIProxyAPI and egress proxy, generating complete Snake source as a function
argument without executing it:

| Probe | Stream events | Bytes | First event | Total | Output tokens | Terminal |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 5,150 | 1,368,076 | 1,094 ms | 93,166 ms | 5,196 | response.completed |
| 2 | 4,997 | 1,327,279 | 1,030 ms | 94,867 ms | 5,103 | response.completed |

All three real workloads completed without natural stream failure; automatic
recovery is established by deterministic fault injection, not falsely claimed
as an observed live OpenAI retry. The new cause diagnostics remain in place for
the next real failure. Test machine and conversation were released/deleted,
its Volume purge was confirmed, and temporary screenshots/build output removed.
Existing user resources and shared Kafka/audit retention were preserved.
