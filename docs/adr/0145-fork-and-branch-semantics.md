# ADR-0145: Reserve Fork for new Sessions and Branch for Agent lanes

## Status

Accepted.

## Context

Pi gives Fork and Branch different storage semantics. `/tree` navigates branches
inside one Session file, while `/fork` and `/clone` create a new Session file.
The upstream `pi-subagents` `context=fork` mode likewise creates a real branched
Child Session file. PiCloud's lane-backed delegated execution therefore cannot
continue to call inherited context a fork without making the public term mean
something different from Pi.

## Decision

- `fresh` starts a delegated Child lane at no parent Entry.
- `branch` starts a delegated Child lane at the exact Entry before the parent
  prompt that requested delegation.
- Subagent Tool schemas, persisted context modes, product badges, tests and
  documentation expose only `fresh | branch`.
- The PiCloud cloud adapter removes `branch` before invoking the upstream local
  child runner. It preserves the upstream workflow engine but does not claim to
  execute upstream's Session-file Fork operation.
- “从此对话开始” / “Fork into a new conversation” remains a true
  `SessionRepo.fork`: it creates a new product Session and physical Pi Session
  with an independent `main` lane and lifecycle.
- A delegated Child may remain independently addressable for scheduling,
  durable events and read-only inspection, but its canonical model context is
  a lane in the parent Pi Session, not another Pi Session.

## Consequences

- One word has one meaning across the UI, protocol and storage model.
- Subagent branch creation remains O(1) in inherited history length.
- Provider-private transcript sanitation that belongs to a true cross-Session
  Fork is not implied by Branch mode; normal Pi provider conversion still runs
  when a Child samples a model.
- Supporting a true forked-session Subagent in the future requires a separate,
  explicit mode and the upstream `SessionRepo.fork` semantics. It must not be a
  fallback for `branch`.
