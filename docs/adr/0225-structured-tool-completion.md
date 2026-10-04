# ADR-0225: Structured infrastructure failures on the Tool reply transport

Status: accepted, implementation in progress, 2026-10-05.

R04-06 reproduced a native Bash failure whose output began with `ownership_lost`
changing Run liveness. Text belongs to the Tool/model context and cannot supply
infrastructure authority. The owner approved replacing this classification.

Boot-scoped Kafka replies use a discriminated envelope: `tool_result` carries
the native final event (including ordinary native Tool errors), while
`execution_failure` carries the original callback identity, a bounded code and
message, and `not_started` or `unknown` effect status. Missing/ambiguous delivery
remains UNKNOWN. No failure implies automatic shell replay. Physical VM evidence
is attached only to a confirmed guest completion.

The Worker mailbox validates the envelope and raises a typed execution failure
for the original promise. The Harness classifies that field, never stdout,
stderr or native result details. Pi still handles normal errors/hooks and the
Worker publishes the canonical Tool Result. Failure of image externalization
can return a Tool error without declaring that a healthy VM has died.

Reuse the current Kafka transport, native Pi result API and PiCloud protocol
parser. There is no new queue, operation ledger, result lookup or consumer.
Move boot reply topics to v2 and deploy the matched Cube completion adapter,
Projector and Worker after draining v1 operations; there is no old-wire fallback.
Guest Tool protocol and native Session history do not change. Version/source
checks reject mixed native/application releases. Rollback requires a matched
drained release, preserving durable Session/Workspace data.

Acceptance: native Bash text with every recognized infrastructure prefix stays
an ordinary Tool failure; actual structured execution loss stops further model
sampling; unknown effects stay unknown; wrong identity/order and old wire are
rejected; cancellation still waits for the original result within its grace.
