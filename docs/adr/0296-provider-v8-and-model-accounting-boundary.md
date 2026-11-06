# ADR-0296: Provider v8 and the model-accounting boundary

Status: accepted for implementation; provider migration first, model accounting
after its acceptance. No billing or production upgrade is implied by this ADR.
Date: 2026-11-06.
Tracking: [Issue #4](https://github.com/cookerpapa/pi-cloud/issues/4).

## Decision

Upgrade the existing CLIProxyAPI adapter to the fixed upstream v8.0.57 commit
`c2f402b45643f0740d70b9010fd7d8d0aab7ef65`. Preserve the private full-input
HTTP/SSE contract in ADR-0289, native Responses compatibility providers, explicit
image execution and the native Harness's retry/cancellation ownership. Pi core,
Session writers, Tool execution and Cube retention do not move into the provider.

Model metering and pricing are separate subsequent slices. Sandbox/storage billing
and payment collection are outside this decision. Model-accounting ownership and
delivery require their own implemented protocol and failure acceptance before
money is charged; the upstream in-memory usage dispatcher is not a durable ledger.

## Adopt-before-build evidence

The assessment inspected the fixed release, its management API/configuration and
usage SDK, and applied the four existing change sets with `git apply --check` in
an isolated checkout. All four require adaptation. v8 already provides execution
UUIDs, request/session correlation, normalized token categories, richer media
usage, request lifecycle hooks and WebSocket-loss classification. Adopt those
contracts instead of reproducing them. Its compatibility executor still lacks
our explicit native `wire-api: responses` selection; retain that bounded feature.

CPA Usage Keeper (MIT) provides SQLite history, estimates and a dashboard, while
cliproxy-costs provides request pricing and a SQLite ledger but explicitly excludes
billing enforcement and several hosted-tool tariffs. Both target v8. Neither
eliminates the source dispatcher's crash window. They are accounting-adapter
candidates, not grounds for installing a second scheduler or treating estimates
as confirmed charges. Detailed selection belongs to the accounting slice.

Sources: [v8.0.57](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.57),
[management contract](https://github.com/router-for-me/CLIProxyAPI/blob/c2f402b45643f0740d70b9010fd7d8d0aab7ef65/docs/management-api-v8.md),
[usage manager](https://github.com/router-for-me/CLIProxyAPI/blob/c2f402b45643f0740d70b9010fd7d8d0aab7ef65/sdk/cliproxy/usage/manager.go),
[Keeper](https://github.com/Willxup/cpa-usage-keeper),
[cost plugin](https://github.com/MelonSmasher/cliproxy-costs).

## Configuration and publication

PiCloud-maintained configuration and management calls use the v8 contract. Convert
existing configuration once; do not maintain dual v7/v8 business paths. Preserve
account credentials, disabled state, individual proxies, model aliases, provider
options and management/client authorization. New-layout values must not silently
override a legacy write: the old policy helper demonstrably leaves nested retry
3 active after setting the flat spelling to 0.

Prepare and validate the private converted document before changing the serving
provider. Serialize publication with the existing release lock, keep the old
provider from observing a partly converted configuration, and record the exact
image/configuration transition. A failed pre-publication check leaves the serving
release intact. Once new writable state is adopted, do not blindly put an older
binary back over it. No permanent development-era configuration backup is added.

Use the pinned v8 configuration normalizer for preparation. The new provider first
starts with the existing document through upstream's loader, then its native v8
management endpoint adopts the prepared canonical YAML with an `If-Match` check.
Only the new provider sees that conversion. This short publication transition
does not add a v7 runtime path to PiCloud's current scripts. Interrupted publication
accepts only the prepared old/new document hashes and resumes toward v8.

This narrowly extends provider publication for the reviewed one-time v8
configuration/management conversion. Validate complete rendered manifests and
source ownership; changes to Worker protocols, PG schemas or accounting ownership
still require their corresponding matched release. Preserve Cube/Workspace
allocations throughout the provider-only slice. Provider replacement can interrupt
an active model connection; recovery follows native retry, never arbitrary Tool
replay or a promise of uninterrupted streaming.

## Acceptance

- v8 initialization, conversion and management operations preserve credential and
  provider semantics and produce one canonical configuration layout.
- Existing Responses, native compatibility, hosted-tool events, image requests
  and semantic stream termination remain covered by local contracts.
- Cross-client/Worker continuation, changed prefixes, model/Tool changes,
  compaction, cancellation, lost connections and request-scoped failures preserve
  ADR-0289. No extra semantic retry or unbounded image/body cache is introduced.
- The private provider route reaches the v8 usage boundary with current request
  identity; normal reader cleanup cannot misclassify a completed response or
  strand accounting delivery.
- Required source checks, fixed provider build/scan and ordinary-size GPT-6 Luna
  live continuation/Stop checks pass before publication is marked complete.
  The owner-deferred approximately 131 MiB live upload is not silently reinstated.
- Record actual source/build/live results, update maintained documentation and
  push each completed commit. Model metering and billing remain open until their
  own end-to-end delivery and reconciliation checks pass.
