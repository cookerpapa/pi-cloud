# ADR-0141: Provider-hosted transcript items

## Status

Accepted on 2026-09-02.

## Context

OpenAI Codex keeps a hosted Web Search action as a distinct Responses item; it
does not rewrite that action into a client-executed function Tool and fabricated
Tool result. Pi 0.84.1 preserves the resulting assistant text and reasoning but
ignores `web_search_call` output items and URL citation annotations.

That omission is safe for one Turn, but it loses useful native history when a
Pi Session moves to another Worker. Treating the search as an ordinary Pi Tool
would be incorrect: the Provider executed it, Tool Broker never authorized it,
and Cube produced no result.

Live probes against the pinned OpenAI Codex and DeepSeek Responses routes found
an important portability boundary:

- both Providers return completed `web_search_call` action metadata;
- OpenAI returns URL citation annotations, while both Providers normally put
  the useful answer in assistant text;
- Pi uses `store:false`, so replaying a call ID alone does not guarantee access
  to Provider-hidden search results;
- raw DeepSeek items are rejected by OpenAI and raw OpenAI items carry no
  restorable search result at DeepSeek.

## Decision

- Model Gateway observes the Provider byte stream without changing it and
  captures completed `web_search_call` items, their output order and assistant
  URL citations at the terminal Responses event.
- The trusted Runner binds that capture to the existing Cloud Step sampling
  identity. Before the complete assistant message is committed, it inserts a
  PiCloud-owned `providerHostedToolCall` content block and citation metadata in
  the same Pi message. PostgreSQL Pi SessionStorage remains the only
  conversation authority; no hosted-Tool sidecar table is introduced.
- The Pi Agent Loop remains unmodified. It executes only content whose type is
  the ordinary Pi `toolCall`; a `providerHostedToolCall` can never reach Tool
  Broker.
- On a later Responses request, native hosted items and citations are replayed
  only when Provider, API and model ID exactly match the issuing assistant
  message. A model or Provider switch omits those native IDs while retaining
  ordinary assistant text, reasoning that Pi can safely transform, and visible
  citation links.
- Search start/completion progress remains an ephemeral Kafka/SSE projection.
  It is UI liveness, not a second durable transcript.
- PiCloud claims durability only for the returned action metadata, assistant
  text, reasoning and citations. Provider-hidden page contents are not returned
  by these routes and are not claimed as durable.

## Consequences

- A Session can move between Workers without losing the fact that the Provider
  searched or the citations attached to its answer.
- Same-route replay matches Codex's native ResponseItem shape without creating
  a universal Web Search Tool abstraction.
- Cross-Provider model switching remains safe and does not create a phantom
  Tool or send foreign Provider IDs.
- A future Pi release with a first-class hosted-item type can replace the
  PiCloud-owned content block behind contract tests; no database migration is
  required because SessionStorage payloads are opaque JSON.
