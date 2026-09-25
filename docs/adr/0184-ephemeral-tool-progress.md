# ADR 0184: ephemeral Tool observation

Status: implemented and validated, 2026-09-25.

Tool updates are observation, not model context or durable conversation history.
Broker forwards bounded text snapshots over pooled internal HTTP to the Session
Projector. Projector reuses authenticated browser SSE with a distinct, unsequenced
`tool.progress` frame. Neither Kafka nor PG stores these snapshots; Worker does
not receive them. Native final results retain the ADR-0183 Kafka reply path and
Pi hooks. Guest execution still implements Pi's optional update callback.

Limit source Bash snapshots to one per second. Broker keeps only the latest
pending snapshot per active invocation; transport errors drop observations and
never fail/retry execution. Internal routing follows the existing Kafka partition
owner, with no per-update PG authority query. A new owner may lose progress
during assignment/replay. Only running Tools can display progress; formal results,
terminal events and seals supersede it. No viewer means no retained output.

The UI shows a collapsed, bounded log preview. Updates replace text, never append
unbounded DOM, enter exports/context, trigger transcript scrolling, or change Tool
status. Reconnect discards observations and starts from durable history. Background
services are not followed after their foreground Tool returns. No process manager,
log archive, new middleware or old-Loop recovery is introduced.

Acceptance: bounded output/slow readers, update/final races, tenant isolation,
reconnect/reassignment, cancellation, silent commands and real Luna/Cube UI calls.

[Acceptance](../reports/tool-progress-acceptance-20260925.md).
