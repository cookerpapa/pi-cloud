# ADR-0140: Native Responses provider gateway

## Status

Accepted on 2026-09-01.

## Context

DeepSeek exposes a native OpenAI Responses endpoint whose server-hosted Web
Search emits semantic `web_search_call` events. CLIProxyAPI's historical
`openai-compatibility` executor accepts a downstream Responses request but
flattens it into an upstream Chat Completions request. That translation removes
Provider-hosted Tool declarations even when the upstream Provider implements
Responses itself.

Direct production-credential probes confirmed that DeepSeek V4 Flash executes
native Web Search and returns `response.completed` without the Chat
Completions `[DONE]` marker. Merely changing PiCloud's Pi adapter would therefore
produce a plausible answer but would not execute the hosted Tool while the
gateway continued translating protocols.

## Decision

- PiCloud contributed a generic CLIProxyAPI `openai-compatibility[].wire-api`
  executor option upstream. The default remains `chat-completions`; an explicit
  `responses` value preserves the native request, hosted Tools and semantic SSE
  terminal events on `/responses`.
- The contribution is tracked in
  <https://github.com/router-for-me/CLIProxyAPI/pull/5382>. Until it is released,
  the one-host image reproducibly builds the public fork commit `48549e65` and
  overlays only that binary on the previously pinned CLIProxyAPI runtime image.
- Production initialization/reconciliation marks only configured DeepSeek V4
  providers with `wire-api: responses`. Other OpenAI-compatible providers keep
  their historical protocol.
- PiCloud's DeepSeek model runtime now uses Pi's `openai-responses` adapter and
  declares the Provider-hosted `web_search` Tool. OpenAI Codex remains on its
  subscription Responses protocol with the same hosted capability.
- Provider credentials, account routing, quota/cooldown and Session affinity
  remain exclusively owned by CLIProxyAPI. The Worker-local Model Gateway still
  sees only a short-lived Turn capability.

## Consequences

- DeepSeek and OpenAI Codex both execute Web Search at their Provider without a
  PiCloud search service or Cube activation.
- PiCloud preserves hosted-search-derived assistant text, URL citations and a
  Codex-shaped native action item in the same Pi Session message under
  ADR-0141. The Pi Agent Loop remains unmodified and never executes that item
  as a local Tool.
- The temporary fork build is source- and commit-pinned, testable from a clean
  checkout and removable after an upstream CLIProxyAPI release contains the
  executor.
