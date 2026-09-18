# Compiled validation acceptance — September 19, 2026

**Implemented and deployed.** Server event/envelope checks now compile once;
schemas, error messages, identity checks, Kafka ACKs and durability boundaries
are unchanged. Runtime revision: `5d6114ba`; subsequent changes add tests/docs.

The package's private `#schema-check` import selects TypeBox 1.1.38's compiled
checker on Node and the existing interpreted checker in browser bundles. This
avoids probing dynamic evaluation under the product's strict CSP. There is no
new dependency, runtime setting, schema copy, authority cache or retry path.
Neither the duplicate serialization nor same-row PG optimization was included.

## Verification

- 659 related tests passed across protocol, runtime-core, runner, Worker,
  Control Plane and Web UI, including real-PG lease/closure/admission tests.
  One opt-in Kafka topic-policy test was not enabled. The isolated test PG was
  removed. All workspace typechecks, formatting, docs and image-closure checks passed.
- Final protocol rerun: 75 tests passed. Differential tests now cover 768
  event/envelope/ACK values, including Unicode length boundaries, invalid numbers,
  missing/extra fields and wrong types. They compare acceptance and exact error
  text, preserve object identity and check that valid server events do not call
  the interpreted checker. Existing heartbeat/order checks are retained.
- Real Chromium loaded the production Vite bundle through Caddy and parsed valid
  and invalid events under `script-src 'self'`: zero recorded CSP violations.
  Administrator/product redirects and configured navigation also passed.
  No `unsafe-eval` was added. An initial fixture mount failed because `/srv` was
  read-only; the fixture now uses its own complete site directory and tracks the
  container before starting it, so failed starts are also cleaned up.
- Control Plane, Worker and Web images were built and deployed at `5d6114ba`.
  All were healthy; there were no active Runs during replacement.

## Real Kafka: current code, compiled versus interpreted

Same bounded method as the [initial study](hot-path-validation-study-20260918.md):
Node 24.18.0, 2 CPU/512MiB benchmark process, 256-byte text, eight partitions,
three brokers, RF3/min-ISR2/acks-all. Actual DirectExecutionLog and producer code;
the harness supplies the surrounding event/ACK validations. One outstanding
append per publisher, 16 warm-up appends each, then two five-second windows.

Four fresh processes ran interpreted / compiled / compiled / interpreted.
The baseline changed only the private checker's module resolution to the existing
browser interpreter; no source, authority, batching or producer configuration was
changed. Test topics had no product Session/PG/Tool consumer.

| 64 synthetic publishers | Interpreted | Compiled |
| --- | ---: | ---: |
| Total measured records | 15,705 | 210,535 |
| Combined window duration | 20.031s | 20.015s |
| Throughput | 784 events/s | 10,519 events/s |
| Individual window ACK p50 range | 79.8–80.7ms | 5.79–5.98ms |

The measured publication throughput gain is **13.4×**, not an end-to-end Agent
capacity claim. At one publisher, window ACK p50 was 4.83–5.04ms versus
3.44–3.57ms. All four owned topics/benchmark containers were removed.

## Real Luna and Cube

Before/after cohorts each completed 15 sequential Luna medium/Standard Turns over
one continuous SSE connection. The first three per cohort were warm-ups. No
build, unit suite or load benchmark ran during timing. Baseline services were
CP `c5cbb98d` / Worker `4fbc4144`; candidate services were `5d6114ba`.

| Remaining 12 Turns per cohort, median | Before | After |
| --- | ---: | ---: |
| Submit → provider dispatch | 99.52ms | 112.97ms |
| Provider route → first text | 1,968.87ms | 1,892.72ms |
| Pi text event → SSE receipt | 10.03ms | 7.63ms |
| Whole Turn excluding provider route | 181.05ms | 183.15ms |

Short-chat total internal latency **did not materially improve**. The benefit is
CPU headroom under many events, not eliminating startup/settlement I/O. Both
cohorts still had long settlement tails: measured p95 633.5ms / 762.9ms. No claim
that this patch fixes those tails or proves their cause. This small before/after
comparison is not a latency SLO; SSE receipt is not browser paint, provider-route
time includes CLIProxyAPI, and independent medians must not be added together.

Functional acceptance on the new deployment covered two real Cube coding Turns
(insertion sort, then binary search), five successful Tool results and byte-for-byte
preservation of the first file; user cancellation followed by a successful next
Turn; two tenants/four concurrent Sessions with distinct expected replies; and
cross-tenant history access denial. PG Attempt times confirmed overlap four.

A pre-upgrade Session continued on the replacement Worker. One model answer
counted its 15 old PING replies as 16: that assertion failed and is not counted as
passing. Product history and the actual native cold-branch reader independently
returned exactly 15 PING replies, 31 unique native entries and no duplication.
A subsequent content-recall question returned the expected old word. No product
workaround was added for model counting accuracy.

Total live execution: **40 Runs**, 39 completed and one intentionally cancelled;
the semantic counting miss above remains documented. Native recorded usage:
60,753 input, 241,664 cache-read and 2,044 output tokens, not a billing reconciliation.
No new long-context/Compaction stress or full product-wide UI audit is claimed.

## Cleanup

All test Attempts were released, sealed and projected beyond their seals before
scoped cleanup. Three test tenants/accounts, five Session views and three
Workspaces were deleted; storage purge completed for all test Workspaces, including
the coding Cube/Volume. Original counts remain 33 tenants, 35 users, one Session
and one Workspace. Private acceptance scripts/credentials and temporary browser
fixtures were removed. Shared production logs/Kafka retain their ordinary policy.
