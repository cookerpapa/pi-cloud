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
  the one-host image reproducibly builds the public fork commit `c12c5a4c` and
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
- Pi 0.84.1 preserves hosted-search-derived Assistant text but does not retain a
  typed `web_search_call` in SessionStorage. This decision does not fork Pi's
  message model; richer hosted-call persistence remains a separate upstream
  concern.
- The temporary fork build is source- and commit-pinned, testable from a clean
  checkout and removable after an upstream CLIProxyAPI release contains the
  executor.

