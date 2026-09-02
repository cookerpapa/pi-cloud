# ADR-0142: Session model settings and Fast tier

## Status

Accepted on 2026-09-02.

## Context

PiCloud previously stored only `sessions.desired_model_profile_id`. The selected
Provider/model was durable, but reasoning effort remained an optional Turn
request override and the Web UI exposed no governed effort selector. OpenAI
Fast mode is a request `service_tier`, not model-visible conversation content;
the [official API guide](https://developers.openai.com/api/docs/guides/fast-mode)
accepts `service_tier: fast` on an individual request.

Codex advertises service tiers per model. Its TUI disables the Fast toggle while
a user Turn is pending or running, then submits a persistent Thread Settings
update through the same ordered thread queue. An already-issued model request
cannot change tier in flight.

## Decision

- The model catalog advertises Provider group, concrete model, supported
  reasoning levels, the default reasoning level and whether Fast is available.
- A human Session stores its complete desired next-Turn settings:
  model profile, reasoning level and nullable service tier. DeepSeek always has
  a null service tier; GPT may select `fast`.
- Creating or updating a Session validates the complete selection against the
  deployment-owned catalog. The update is rejected while a Turn is queued,
  running or cancelling.
- Turn admission locks the Session and copies Provider, model, reasoning level,
  service tier and credential binding into the immutable Turn snapshot. Worker
  retries and recovery read that snapshot rather than the Session's newer
  desired settings.
- The trusted Model Gateway injects `service_tier: fast` only into an OpenAI
  Codex Responses request whose issued runtime capability contains Fast. It
  rejects a tier/provider mismatch before forwarding.
- Reasoning level and Fast are runtime request settings. They are not written
  into Pi `messages[]`, Compaction summaries or synthetic prompts, so switching
  to DeepSeek cannot create model-context incompatibility.
- The Web selector is a cascading Provider → model → reasoning menu. GPT shows
  a Fast switch beneath reasoning. One Apply action commits the complete
  settings for the next Turn.

## Consequences

- Loading a Session requires one indexed join to its desired model profile plus
  the two Session setting columns; no transcript scan is needed.
- Historical Turns retain the model settings actually used even after the
  Session default changes.
- Fast cannot accelerate a request already in progress. It affects the next
  Turn, matching Codex's guarded UI and ordered settings behavior.
