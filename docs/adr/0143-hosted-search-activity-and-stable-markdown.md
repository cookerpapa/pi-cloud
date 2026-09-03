# ADR-0143: Hosted-search activity and stable Markdown streaming

Status: accepted

## Context

Responses providers expose a Web Search call as an output item with a stable
item ID. Lifecycle events announce `in_progress`, `searching` and `completed`,
while `response.output_item.done` carries the final `search`, `open_page` or
`find_in_page` action. One model response may contain several concurrent or
sequential calls.

PiCloud previously collapsed the entire response into one Boolean “searching”
state. Completed calls disappeared, call counts and action details were lost,
and a later call repeatedly mounted and removed the same indicator. The Web
client also reparsed the complete growing Markdown answer on every animation
frame, so citation-heavy text could reshape previously rendered links.

## Decision

- Parse Provider SSE only inside the trusted Model Gateway while forwarding its
  byte stream unchanged to Pi.
- Project one PiCloud-owned activity identity per Provider Web Search item.
  Publish a durable Kafka event when that item starts and update the same item
  when its final action is known.
- Normalize only portable display fields: search queries, opened URL and
  find-in-page pattern. Remove DeepSeek's transport-only `ws_call_id` query and
  URL-fragment markers from the public projection.
- Keep completed Provider-native items in the Pi assistant message. The
  canonical conversation projector reconstructs settled Web Search activity
  from that message, so a reload does not depend on retained live Kafka tails.
- Render adjacent calls as one compact activity group with a count and action
  details. A running call remains the same keyed row when it completes.
- Split in-flight Markdown into completed blank-line-delimited blocks and one
  mutable tail. Memoized completed blocks no longer reparse as new deltas
  arrive; the final answer still receives one complete Markdown parse. Fenced
  code and reference-style links remain unsplit where cross-block parsing is
  required.

## Consequences

- GPT and DeepSeek use the same PiCloud activity protocol without pretending
  their native search implementations are identical.
- Search progress remains an AcceptedFact through the existing Kafka/SSE path;
  no token-delta rows or new durable authority are added to PostgreSQL.
- Query text and visited public URLs become visible to the conversation's
  authorized viewers, matching the Agent activity users already requested.
- A Provider that omits action details still renders a correctly paired generic
  search activity.

