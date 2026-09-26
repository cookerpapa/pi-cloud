# ADR-0187: model retry ownership

Status: accepted and implemented, 2026-09-26.
Validation: [Pi-alignment repairs](../reports/pi-alignment-repair-20260926.md).

CloudAgentRuntime owns retries of an incomplete model sampling Step, using the
existing frozen-step identity, cancellation and bounded retry policy. Pi's lower
transport retries stay disabled. Model Gateway forwards one request per admitted
sampling attempt and propagates the original failure; remove its extra HTTP
retry loop. Each new admitted model request is counted normally.

The deployment-owned CLIProxyAPI configuration disables additional credential
retry rounds (`request-retry: 0`). Its first-round account selection/failover
remains its credential-supply responsibility. Consequently the cloud request
budget counts logical sampling requests, not a promised exact number of provider
account attempts. No provider credentials, budgets or second accounting ledger
move into the Runner.

This refines the previous layered transient-error handling rather than removing
model recovery. Compaction continues to use Pi's bounded summary retry primitive.
Tools and workflows are never replayed as part of model recovery. Image transport
is unrelated and remains deferred.

Acceptance: gateway failure performs one send; a later explicitly admitted
request can succeed; cancellation interrupts uploads/streams; existing native
retry tests prove completed Tools are not repeated. Generated and existing local
gateway configuration receives only the owned root policy change, preserving
credentials and provider settings.
