# Native model continuation and phone UI withdrawal

Status: deployed as `continuation-5f-final`, image source `cee48223`, schema 202,
Helm 115; end-to-end acceptance and asset preservation complete. ADR-0282 adds
no PG migration, Tool protocol or storage authority. Subsequent operator changes
configure the provider's upstream transport and strengthen acceptance.

## Behavior

GPT requests use Pi 1.0's native `auto` transport through the Worker Model Gateway.
Pi selects complete or incremental input using its own previous-response state.
The gateway forwards the selected request unchanged after validating the existing
capability/model/Fast binding and reserving the request budget. Each private
WebSocket frame has fresh sampling metadata outside the provider JSON. Child
Conversations and context maintenance have separate incarnation-scoped connection
identities; cleanup releases native cached input and sockets.

First requests, context replacement and reconnects may still carry full image
context. Missing continuation uses native recovery; unsupported WebSocket falls
back through native SSE. Transport failures can retain that fallback for the
remaining native cache scope. A new owner starts with a fresh scope. No Tool replay,
partial Tool admission, new provider context database or extra sampling retry
owner is added. Request bytes and first-frame/write timings are content-free;
gateway write timing ends at CLIProxyAPI, not at the model provider.

CLIProxyAPI's per-account `websockets` flag is required too. Without it, the proxy
accepts downstream deltas but reconstructs full HTTP requests upstream. Both
installed Codex accounts now enable native upstream WebSockets through the
provider's management API. The maintained matched/provider release operators
apply that preference; importing accounts requires rerunning
`node scripts/configure-provider-websockets.mjs`. The operator changes only the
transport flag and never prints or copies account credentials. Acceptance verifies
the flags read-only and checks actual provider Pod transmission to catch hidden
upstream expansion. This adds no Worker hot-path account/PG queries.

The proxy currently disables outgoing WebSocket compression because of documented
flate-tail failures. This release preserves that policy and existing HTTP zstd;
it removes repeated image uploads through native continuation, not by silently
deleting old images, reducing their quality or changing the compaction threshold.

The Web cloud-phone entry and its picker/screen component, styles and translations
are deleted. The alternate-target executor port/operator API remains a verified
prototype. Existing phone history images still render. Android acceptance now
uses the API for binding/screen reads and verifies that the page has no phone entry.

## Source and isolated provider evidence

Twenty focused tests cover native Pi + Gateway + WebSocket upstream continuation,
per-request sampling, separate conversation/summary caches, changed context,
missing reference, connection loss, HTTP fallback, Stop/owner loss/inactivity,
model/budget rejection, frame/response bounds, overlapped requests, a blocked
reader, provider close-code propagation and resource cleanup. The actual Pi test's second Tool round omits the
256 KiB image entirely and has less than 1% of the first request's bytes. Ordinary
HTTP Gateway and existing request-policy contracts remain in the relevant gate.

Early downstream-only probes were insufficient to prove external bandwidth savings;
their evidence is retained as such. After upstream eligibility was enabled, a
separate real Luna probe through the new local Worker gateway and actual
ScopedDurableModels/Pi provider succeeds:
one connection, two requests, one complete input, one delta, zero SSE fallback.
The second answer identifies the first request's red image correctly after a Tool
result. First Tool output takes about 3.92 seconds; second text about 1.42 seconds.
The tiny fixture is a correctness check, not a latency claim for the owner's
250k-token Sol conversation. An initially invalid one-pixel PNG fixture was
replaced by a valid generated PNG; that failed fixture is retained separately.

The Web presentation gate passes with the removed phone entry. The whole-repo
check exposed a pre-existing registry expectation that omitted the already
deployed `schedule` Tool; its expected advertised list is corrected and the
targeted test passes. No Tool implementation is changed by that correction.

The matched artifact gate found CVE-2026-84782 in the provider base image's
`libssl3` and `openssl` 3.0.20-1~deb12u2 packages. Pin the Debian security revision
3.0.22-1~deb12u2 in that image only and rescan; no provider source/model or account
configuration changes. [Debian advisory](https://lists.debian.org/debian-lts-announce/2026/10/msg00053.html).

## Publication acceptance — passed

The deployed fixture uses a 2,317,596-byte synthetic image and two sequential
Runs on different Workers. Both return its correct color and complete two Bash
Tools. The first request in each Run carries complete context; later requests
reuse the native upstream connection and response reference.

| Measurement | First Run | Reopened Run |
| --- | ---: | ---: |
| Initial model request | 3,110,618 B | 3,111,879 B |
| Each subsequent request | 19,802 B | 19,802 B |
| Provider Pod outbound bytes for all three requests | 3,448,166 B | 3,431,668 B |
| Subsequent first-frame latency | 0.41–0.68 s | 0.44–1.24 s |

The outbound counter includes encrypted upstream traffic, returned responses and
incidental provider management traffic. It proves the proxy did not expand both
deltas into full image uploads. It is measured on the single isolated provider
Pod, not inferred from token-cache hits or only the local gateway's body size.
The page has no cloud-phone entry. Owned fixture Sessions, compute, Volumes,
image objects and tenant credentials were physically reconciled and removed.

All 15 protected account/configuration/native-history table snapshots match, as
do 5,816 protected Workspace files and 27 configuration/secret hashes. All 47
original image objects pass length/SHA checks. The logical machine and its Volume
are retained, and the original 4188 application serves the same HTML hash after
verified old-allocation closure and recovery. Only its log/PID artifacts change.
All 29 serving Pods are ready and no active Run/writer/Tool binding remains.

Workspace type checks and 2,238 assertions passed in the broad run; its one stale
schedule-registry expectation was corrected and passed a targeted rerun. The 20
focused model/protocol assertions, browser presentation checks, operator checks,
375 deterministic fault cases, clean-repeat Kafka transport checks and all twelve
image scans pass. Fault evidence retains its actual pre-commit/dirty-tree stamp;
it is not relabelled as a final-image test. The first transport cleanup exceeded
Docker's caller wait; absence and network removal were subsequently confirmed,
and the clean repeat completed normally.

Very large cold input remains a separate limitation. Approximately 113 MB probes
did not establish a successful complete round: earlier probes used the proxy's
HTTP upstream mode, and the later native-upstream warmup probe lost its connection.
These are not counted as acceptance. First/cold requests can still require full
transfer; no general bandwidth, inference-latency or arbitrary-size guarantee is
made. The tested reduction applies after a successful reusable response.

Publication used the maintained matched operator and compute-only maintenance. Preserve
accounts/configuration, native history, image objects, logical development-machine
intent and Workspace Volume. Confirm old writer/physical allocation closure before
discarding its handle. Restart retained applications after compute returns.

Run the owned deployed fixture:

```sh
PI_CLOUD_LIVE_MODEL_CONTINUATION_CHECK=1 node --import tsx \
  scripts/run-live-model-continuation-check.mjs PRIVATE_EVIDENCE_DIRECTORY
```

It uploads a large synthetic image to a new owned Session, performs two Bash Tools,
checks native transport byte counts, then opens another Run against the retained
image. Both start with complete input and continue using substantially smaller
deltas. It verifies the removed phone entry in the real page and confirms physical
Workspace/attachment cleanup before deleting its fixture tenant. Run the relevant
native input/Cube recovery checks and preservation comparison alongside it.

Private evidence is under
`deploy/production/runtime/release-evidence/model-continuation-20261027/`.
