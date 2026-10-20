# ADR-0263: Model response interpretation and unbounded Agent work

Status: implemented and deployed as `model-runtime-058925bb`, schema 192, 2026-10-20.
[Delivery and limits](../reports/model-runtime-repair-20261020.md).
Owner-approved [plan](../reports/model-request-response-repair-plan-20261019.md)
and [review evidence](../reports/model-request-response-review-20261019.md).

## Decision

Agent work has no total elapsed-time ceiling. Delete the Runner timer and its
policy column, command/runtime fields, environment/Helm values and dependent
validation. Network header/idle, Tool and shutdown bounds remain independent.
The existing PG-issued physical-Session lease is still the execution authority.

Model capabilities are boot-local Run/Conversation grants under that authority,
not another timed lease. Revoke them on cancellation, ownership loss, work closure
or Worker retirement before unrelated cleanup. A new boot issues new tokens;
there is no renewal scheduler or per-request PG authorization in the Gateway.

Worker shutdown stops claims, waits a bounded drain interval, then revokes the
remaining assignments through existing Session closure/same-Run recovery. It does
not request user Stop or clear pending native input. Bound retirement and process
cleanup independently of Agent duration; failure to confirm closure preserves
durable ownership/recovery intent and never authorizes a successor early.

Use Pi's public Models/provider-event ports for response semantics. One request
owns item identity, native-content mapping, phases, completed hosted content and
semantic outcome. The Gateway owns HTTP admission/transport/cancellation/timing;
remove its duplicate SSE interpreter and semantic callback plumbing. Durable
alone owns sampling retry. Known transport failures retain a stable sanitized
retry meaning across both maintained provider adapters.

## Native progress representation

Pi's public stream protocol has text/thinking/Tool events, not a generic metadata
update. Completed hosted searches must nevertheless reach native progress even
when no later text arrives. Represent each as an empty native TextContent slot
with PiCloud-owned completed-hosted metadata. Emit a valid empty text start/end
pair in the same assistant response; no visible text, local Tool call, separate
Entry or alternate storage write is manufactured. Source/native items and hosted
slots receive stable positions within that response.

The slot has an owned opaque text signature used only as a replay placeholder.
At the public payload hook, replace the placeholder with the actual completed
provider item for the exact issuing provider/API/model. Remove such slots from
other-provider context. Never send synthetic placeholder messages upstream.
Canonical PiCloud history interprets the metadata as a hosted-search activity;
normal text presentation ignores the empty carrier. This replaces the old
non-native `providerHostedToolCall` content block, without a dual-format reader.

Provider events remain read-only. Produce detached progress snapshots and merge
completed fields/citations without shifting already-exposed text identities.
Incomplete local Tool drafts stay empty private slots until a complete successful
model response (ADR-0230). The existing native commit boundary determines what
survives Stop or worker loss; uncommitted provider events have no stronger promise.
Late replies never overwrite native abort. Start/completion display facts retain
ADR-0143's existing small durable activity path, not a second result store.
Pi 1.0's context selection is unchanged: aborted/error Assistant entries remain
history but are excluded from later model context by the native Harness. Preserving
their hosted metadata does not silently override that native rule.

Native signatures at item completion override early phase observations. Model
success/error/abort is measured at the Models boundary, separately from transport
EOF/disconnection. Observability failures cannot change native execution.

## Adopt versus build

Reuse pinned Pi 1.0 Models callbacks, public stream events, Harness transactions
and native partial-to-aborted conversion; reuse Node HTTP cancellation, the
existing Worker retirement protocol and PG/Kafka replay protection. No alternate
workflow/checkpoint framework preserves these boundaries with less integration
work than this bounded response adapter. Public-port/native-Harness contract tests
must establish the carrier/abort semantics before relying on them in production.

## Cutover and acceptance

Schema/application cutover removes the obsolete duration policy and old native
hosted representation. Drain writers and use the owner's development-era cleanup
authorization if old business history remains; preserve original accounts, model/
provider configuration and credentials. Do not discard physical ownership before
confirmed cleanup. Protocol and artifact identities must match deployed code.

Cover both model routes, transient and permanent failures, Stop during retry,
reasoning/text/Tool index interleaving, hosted-only progress, commit/abort races,
cold replay, capability revocation and bounded Worker handoff. Confirm active
native replay references survive ordinary Kafka cleanup age. Run repository and
matched artifact gates, followed by Luna/Cube/browser/recovery acceptance and a
real Run crossing the removed ten-/fifteen-minute thresholds. No multi-day SLA
or exactly-once external effect is inferred from those samples.
