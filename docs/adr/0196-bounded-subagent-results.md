# ADR-0196: Subagent results must fit native history

Status: implemented and validated, 2026-09-27, following owner approval of
repository-review repairs D1, D3 and D4. This decision covers D1 only.
See [regression, matched rollout and Luna acceptance](../reports/repository-review-followup-20260927.md).

## Decision

Keep the existing 900 KiB execution-fact limit and the existing Workspace/image
storage authorities. Bound a Subagent's returned text to 256 KiB after JSON
string encoding, including UTF-8 and escaping. This leaves space for the native
message, its accompanying display event and their identity/record envelopes.
The larger Tool-reply transport limit is not a result-admission budget.

Use one shared limit and serializer in the trusted Workflow receiver and
Subagent Tool. The fixed Cube workflow wrapper enforces the same budget before
emitting completion; the trusted receiver still checks untrusted frames. Apply
the budget to explicit workflow values, direct child/control results and error
text. Small string/JSON results retain their exact existing representation.

An oversized result produces a bounded Tool error. It is not truncated into a
successful JSON value, retried, or moved to an implicit blob store. The error
states that execution may already have produced effects and directs the Agent
to inspect them and return a summary or an explicitly written Workspace path.
A returned oversized error is bounded as well. Cancellation, missing/malformed
completion and transport loss keep their existing UNKNOWN semantics.

Pi's normal Tool-error handling and after-hook/canonical append path stay in
charge. Do not raise Kafka limits, patch the Pi loop, or add a result cache.

## Acceptance

Cover plain text, structured JSON, Unicode/escaping, exact boundary values,
oversized success/error and receiver checks independent of the guest wrapper.
A script that writes a marker and returns too much must execute once, leave its
marker, and return an explicit bounded error. Verify through the native Harness
that this Tool error is persisted and a later model step can finish normally.
The largest accepted result plus the real display/checkpoint envelope must fit
the existing execution-fact budget. Retain cancellation and lost-reply tests.
