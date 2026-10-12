# Model egress TLS investigation

Date: 2026-10-12. Scope: identify the model TLS failure boundary and recheck the
deployed native live-state retention policy. No application, provider credential,
proxy route, model retry or storage policy was changed.

## Finding

The reported `utls: TLS handshake: EOF` comes from CLIProxyAPI establishing TLS
to `chatgpt.com`. It precedes an HTTP model request on that connection. The
configured path is:

```text
CLIProxyAPI
  -> PiCloud bridge relay -> host relay
  -> Windows v2rayN / sing-box HTTP proxy on 10808
  -> configured AnyTLS node -> chatgpt.com:443
```

The model TLS endpoints are CLIProxyAPI and `chatgpt.com`; the intermediate
proxies transport that connection. AnyTLS also has its own encrypted connection
between the local proxy and its node. Failure of that outer path can surface as
an EOF in the inner model TLS handshake.

The same approximately three-second EOF reproduced **without PiCloud's relay**,
by connecting a credential-free TLS probe directly to the local proxy. PiCloud,
Kafka, PG, Cube, model payloads and the Agent Loop are therefore not necessary
to reproduce this failure. This is a localization result, not a claim that all
possible relay failures have been excluded.

## Observed configuration and controls

- Serving PiCloud remains `native-live-1370d871`, schema 186.
- CLIProxyAPI source is pinned to `48549e65b86d17648029190331807b89e7fd65f4`;
  its ChatGPT transport uses uTLS 1.8.2 and `HelloChrome_Auto` (Chrome 133).
- Windows port 10808 belongs to v2rayN's sing-box 1.12.17 process. Its build
  metadata includes `github.com/anytls/sing-anytls v0.0.11`.
- The running proxy exposes one AnyTLS outbound and uses Rule mode. Node
  addresses, route names and credentials are omitted from this public report.
- Probes performed HTTP CONNECT followed by TLS only: no model API requests,
  provider credentials, conversation content or shell work in a guest.
- The probe used the same uTLS version/preset, with a host Go 1.26.0 build.
  It is not a replay of the complete deployed CLIProxyAPI binary or model request.

The controls alternated production relay/direct proxy routes and Chrome/standard
Go TLS clients. A second group also used an isolated loopback instance of the
existing PiCloud host-relay implementation, without K3s or its Unix bridge.

| Group | Route / client | Successes | Failures |
| --- | --- | ---: | --- |
| Initial comparison | PiCloud relay / Chrome 133 | 18/20 | Two EOFs at 3,004 ms |
| Initial comparison | Direct local proxy / Chrome 133 | 20/20 | None |
| Initial comparison | PiCloud relay / standard Go TLS | 20/20 | None |
| Initial comparison | Direct local proxy / standard Go TLS | 20/20 | None |
| Three-route comparison | PiCloud relay / Chrome 133 | 30/30 | None |
| Three-route comparison | Isolated host relay / Chrome 133 | 30/30 | None |
| Three-route comparison | Direct local proxy / Chrome 133 | 29/30 | One reset at 5,003 ms |
| Direct confirmation | Direct local proxy / Chrome 133 | 97/100 | Three EOFs at 3,002–3,003 ms |

There were 270 handshakes in total. These bounded samples are not a production
failure-rate estimate. The first small group alone could have suggested a relay
problem; the subsequent direct reproduction rules out that inference.

The three direct EOFs started at 05:45:21.904, 05:45:31.965 and 05:45:35.068 UTC.
HTTP CONNECT returned 200 within 0–1 ms, then TLS failed about three seconds
later. A proxy CONNECT acknowledgement did not establish that the remote path
was already usable.

For the distinct 05:43:05.912 UTC direct failure, the local proxy emitted an error
at 05:43:10.917 UTC identifying failure to create an AnyTLS session: its TCP dial
to the configured node timed out. The client observed a connection reset. This
is direct evidence of an outbound node-connectivity failure; it should not be
silently treated as proof of the cause of every earlier three-second EOF.

## Why the three-second timing matters

The pinned [AnyTLS session implementation](https://github.com/anytls/sing-anytls/blob/v0.0.11/session/session.go#L126-L159)
starts a three-second acknowledgement deadline when opening a later stream on
a version-2 session. If the acknowledgement does not arrive, its callback closes
the session. Receiving the acknowledgement cancels that deadline. The
[client](https://github.com/anytls/sing-anytls/blob/v0.0.11/session/client.go#L70-L118)
can reuse an idle session when creating a new stream.

This is a strong match for the measured timing and the local proxy's initiating
close, but it remains an **inference**, not a captured timer firing in the running
process. Client-side evidence cannot determine whether an old tunnel was no
longer usable, packets were delayed/lost, or the node was slow to acknowledge.
No conclusion that OpenAI itself rejected the request follows from these data.

The ordinary sniff timeout is not three seconds by default; the maintained
[sing-box documentation](https://sing-box.sagernet.org/configuration/route/rule_action/)
documents 300 ms. Increasing PiCloud request deadlines would not repair a
connection already closed by its proxy.

## Remaining external evidence

The acceptance gap is closed by the earlier successful full Cube suite. The
intermittent proxy-path issue remains open. The next investigation needs either
node-side connection/acknowledgement logs for the UTC windows above or an
operator-selected alternate node/path for a controlled comparison. Whether the
current node is self-managed was asked of the owner; no server ownership or SSH
authorization was inferred from its IP address.

Do not patch Pi's loop, replay Tools, remove fencing or introduce a second model
retry owner to conceal this error. No such changes were made.

## `pi.live` storage clarification

`pi.live` was not removed from Pi. [ADR-0244](../adr/0244-kafka-backed-native-live-state.md)
changes its physical persistence and retention:

| Location | Retained data |
| --- | --- |
| Worker / Projector memory | Current materialized live state |
| Kafka | Complete accepted native changes and the suffix needed for recovery |
| PG `pi_durable_current` | Latest stable/settlement or ordered-handoff checkpoint, with replay coordinates while incomplete |
| PG native history | Canonical completed/interrupted Assistant Entries and other retained native facts |
| PG native commit headers | Ordering/integrity metadata; these still advance during generation |

The current adapter was rechecked in a disposable official PG container with the
maintained `native-live-20261012/measure.mjs current` experiment. For 1,001 partial
changes producing 257,000 text bytes:

- PG live journal rows/bytes: 0/0; periodic derived full checkpoints/bytes: 0/0.
- PG current baseline during generation: 197 bytes, plus one Kafka replay
  reference and 1,002 native commit headers.
- Ordered handoff: one 258,245-byte current checkpoint; exact text and native
  delta count restored, and the replay reference cleared.
- Normal completion: the current live baseline returned to 197 bytes, with the
  completed Assistant Entry retained canonically.

Thus “PG no longer accumulates streaming intermediate bodies” is correct;
“`pi.live` is never stored anywhere” and “generation performs no PG writes” are not.
Production was empty after prior fixture cleanup, so its zero live-row count was
not used as proof of this policy. Schema/image identity and the controlled
experiment supplement the earlier real Stop/dual-process recovery acceptance.

An initial direct Vitest invocation lacked its required disposable PG fixture
and failed setup before executing cases. The maintained isolated measurement
then completed successfully; no production database was used for the experiment.

## Cleanup and evidence

The temporary loopback relay on 12451 and disposable PG container were stopped.
Effective proxy configuration remained Rule / warn. The sing-box 1.12.17
[Clash compatibility handler](https://github.com/SagerNet/sing-box/blob/v1.12.17/experimental/clashapi/configs.go#L49-L67)
ignores log-level PATCH requests; an attempted diagnostic adjustment did not
enable debug logging, and the unchanged effective level was verified afterward.
No proxy routes, model/provider credentials or deployed artifacts changed.
Control Plane/web/Workers remained Ready at 1/1, 1/1 and 2/2; readiness returned 200.

Private probe source, build inputs, timestamped results, filtered proxy logs and
PG measurement are under `dist/research/tls-20261012/`. They contain no model
payloads and are not committed. Public findings omit node addresses and other
operator-specific connection details.
