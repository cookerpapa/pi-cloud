# Native model continuation and phone UI withdrawal

Status: implementation and source/isolated live verification complete; matched
deployment pending. ADR-0282 adds no PG migration, Tool protocol or storage authority.

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

The proxy currently disables outgoing WebSocket compression because of documented
flate-tail failures. This release preserves that policy and existing HTTP zstd;
it removes repeated image uploads through native continuation, not by silently
deleting old images, reducing their quality or changing the compaction threshold.

The Web cloud-phone entry and its picker/screen component, styles and translations
are deleted. The alternate-target executor port/operator API remains a verified
prototype. Existing phone history images still render. Android acceptance now
uses the API for binding/screen reads and verifies that the page has no phone entry.

## Source and isolated provider evidence

Nineteen focused tests cover native Pi + Gateway + WebSocket upstream continuation,
per-request sampling, separate conversation/summary caches, changed context,
missing reference, connection loss, HTTP fallback, Stop/owner loss/inactivity,
model/budget rejection, frame/response bounds, overlapped requests, a blocked
reader and resource cleanup. The actual Pi test's second Tool round omits the
256 KiB image entirely and has less than 1% of the first request's bytes. Ordinary
HTTP Gateway and existing request-policy contracts remain in the relevant gate.

A raw subscription probe through installed CLIProxyAPI succeeds with a full image
request followed by an incremental request. A separate real Luna probe through
the new local Worker gateway and actual ScopedDurableModels/Pi provider succeeds:
one connection, two requests, one complete input, one delta, zero SSE fallback.
The second answer identifies the first request's red image correctly after a Tool
result. First Tool output takes about 3.4 seconds; second text about 2.55 seconds.
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

## Publication acceptance

Use the maintained matched operator and compute-only maintenance. Preserve
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
