# Development-machine failure boundaries — 2026-09-06

Implemented ADR-0151 without replacing user machines or changing the Cube
template. The original incident's first read exception had been discarded, so
its exact transport cause cannot be reconstructed. The destructive handling
after that exception was reproducible in code and fault tests.

## Real acceptance

Ran `PI_CLOUD_LIVE_MACHINE_FAILURE_CHECK=1 node --import tsx
scripts/run-live-machine-failure-check.mjs` twice against the local production
HTTP API, Cube KVM, Kafka, PostgreSQL and paid DeepSeek V4 Flash. Both passed.

| Check | Result |
| --- | --- |
| Kill only the application server | Preview returns HTTP 502, application-port message; terminal/files still available |
| Restart application on the same port | Preview HTTP 200 |
| Restart only Tool Broker | Same runtime ID; `/etc` marker, home files and application process survive |
| Two coding rounds per trial | Insertion-sort and binary-search implementations/tests pass |
| Model-visible reset during Broker replacement | Zero markers in each trial |
| Generated model output | 15,658 + 12,182 output tokens; cache-read counts recorded separately |

First/second coding rounds took 130.933/9.579 seconds in trial one and
81.712/17.178 seconds in trial two. These include model generation and are not
platform overhead benchmarks. The initial root-owned fixture directory made the
Agent repair file ownership; the reusable script now gives its project directory
to uid 1000 before coding.

The latest machine-readable result is `machine-failure-acceptance-latest.json`.
Images used the existing compatible template revision; host application source
included this working-tree fix. No actual WSL power-loss experiment was run.
HTTP forwarding, not graphical game interaction, is the scope of this test.

## Deterministic regression

Tool Broker suite: 84 passed, 3 environment-gated tests skipped. Selected native
Runner/remote-tools/World State tests: 33 passed. Preview and development-service
tests: 8 passed. Type checks, formatting, documentation and runtime-policy checks
passed. Cases cover unknown mutations, readonly disconnection, cancellation after
dispatch, actual Guest probes vs API readiness, recovery capsule retention in
PostgreSQL, duplicate stop, Broker shutdown, unavailable-to-reconnected versus
changed-Guest World State, missing application sockets, and first-error retention
even when both subsequent sampling and cleanup fail. A broken Tool binding does
not issue another model request; its failed Tool Result remains in Pi history.

## Cleanup and limits

Both disposable machines were explicitly released and their test conversations
deleted. An additional cleanup defect was found: the unprivileged Volume gateway
can remove identity metadata before recursive deletion fails on root-owned files.
Only the two known test residues (one generated HTML file each) were removed with
targeted owner-appropriate operations, then their Cube Volume metadata deleted.
This is recorded in BACKLOG; automatic GC of arbitrary root-owned Guest trees is
not claimed fixed here. Existing user files and the failed `cc` environment were
not removed or silently replaced.

Host shutdown is not a pause snapshot. A surviving Volume does not prove rootfs,
memory or background-process recovery. A genuinely missing original runtime
still requires operator/user-directed recovery; this fix prevents a Tool failure
from unnecessarily destroying an otherwise surviving owned machine.
