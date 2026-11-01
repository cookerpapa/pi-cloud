# Initial message placement — November 1, 2026

Presentation release `input-placement-20261101` is deployed from `6025dc30`
through the scoped Web operator, platform Helm revision 137. The prior matched
backend remains installed. [ADR-0290](../adr/0290-human-input-boundary-and-feedback.md)
records the presentation boundary.

## Behavior

- An idle submission immediately appears as a provisional user bubble in the
  transcript. Its local sending/unconfirmed state remains distinct from a durable
  receipt. An accepted initial Run stays there while waiting for Worker claim.
- Only native steer/follow-up input appears above the composer. One queue
  controller supplies both the pending list and initial-message edit/withdraw
  controls. No extra polling or second server queue is introduced.
- Initial input can be edited or withdrawn before claim. Successful withdrawal
  returns its text/attachments to the composer. A claim/edit conflict preserves
  the edit for recovery instead of rewriting running input.
- A retry uses the original captured payload and idempotency key, preserving a
  newer composer draft. HTTP receipts determine placement when the displayed
  busy/idle state is stale. An early stream never borrows an old prompt.

The provisional bubble exists only in browser presentation. Only the receipt
associates it with an actual Run; text matching is not an identity mechanism.
If authoritative input arrives before the receipt, redundant provisional text
is suppressed while the unresolved status, draft and retry identity remain.
Native storage, public schemas, Run admission and Worker ownership are unchanged.

## Verification

- Scoped release gate: 253 tests across 33 files, including 236 Web tests;
  Web TypeScript, complete browser presentation, queue and history-layout checks.
- Browser cases cover early stream/late receipt, discovery-first and lost-ACK
  ordering, exact retries after editing another draft, stale busy/idle views,
  image-only input, initial edit/withdraw, claim conflicts, native queue actions,
  mobile layouts and long-history scrolling/selection.
- Web image built, SBOM/scans and manifest preflight passed; only the Web
  Deployment image changed. Source formatting and documentation checks passed.
- Real GPT-6 Luna/Cube browser acceptance passed: two Runs (one completed,
  one stopped), six queue actions, initial transcript placement, native queued
  input processing, Stop draft return and owned fixture cleanup.
- After cleanup all 29 running Pods were Ready. All 28 non-Web Pod identities
  and the allocation identities, generations and states of all nine pre-existing
  development-machine records were unchanged; no active test Run remained.

One local browser test launch encountered `ERR_NETWORK_CHANGED` before its fixture
loaded. Its failure log was retained; a clean rerun and the committed release
gate both passed. No provider or large-image acceptance was needed for this
presentation-only change.
