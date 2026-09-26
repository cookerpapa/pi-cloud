# ADR-0185: native Record semantics and invocation identity

Status: accepted and implemented, 2026-09-26.
Validation: [Pi-alignment repairs](../reports/pi-alignment-repair-20260926.md).

## Context

The September 26 review reproduced two native Record mismatches and a scope
collision outside the already-correct operation-ID Kafka reply mailbox. The
owner authorized repair after checking the historical decisions, with images
deferred and no legacy compatibility path. September 22's discussion chose an
opaque operation identity, whole guest Tools and UNKNOWN rather than effect
replay. ADR-0148 still requires validated intent before execution; ADR-0166
keeps direct delegation independent of Cube.

## Decision

Use Pi's Step-attempt semantics: a new sampling Step starts at one; only a retry
of its unfinished response increments the attempt. Cloud sampling identity
remains a separate transport/governance concern. Tool intent ordinal is the
original index among the assistant's Tool calls, including rejected earlier
calls. Compaction attempts start at one for each new compaction Step.

A Tool invocation's native result Entry ID supplies its cloud-facing identity.
Allocate it in the trusted Runner for that response/call, including calls that
are rejected before execution. Preserve the provider Tool ID in native Pi
messages and guest callbacks. Scope Subagent/workflow deduplication and public
presentation to the invocation, not a provider ID reused across responses.
Repeated IDs inside one response are ambiguous and rejected before the Assistant
Entry/effects; they cannot corrupt the native result mapping or later context.
The ordinary remote operation UUID and boot-scoped Kafka reply path remain.
No new operation ledger, per-Tool lease or effect retry is introduced.

Code-owned before/after Tool policies use Pi's public hooks. Rejection precedes
the intent boundary; after-hook output becomes canonical. This exposes a trusted
composition seam, not user extensions or a durable approval product.

The development cutover uses the new execution-log generation. Existing test
resources may be retired rather than interpreting old identifiers through a
second implementation. Native logs are never rewritten in place.

## Acceptance

Require real Pi-loop tests for ordinary multi-Step sampling, retry, rejected
arguments before a valid Tool, before/after hooks, repeated provider IDs across
responses, independent Subagent invocations, live/cold presentation and progress
identity. Keep intent ACK-before-effect, cancellation, seals and no-replay tests.
Image transport and storage contracts are outside this decision.
