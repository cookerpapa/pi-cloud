# ADR-0173: Reuse claimed startup context

Status: accepted, 2026-09-17.

Run claim selects one materialized, row-locked candidate and reads its context in
the same statement; configuration is a separate fixed-ID read. It does not repeat
queue eligibility in the context read. Both next-Run and explicit-ID dispatch use the same eligibility conditions;
physical-Session ownership is still checked after acquiring its lock.

The internal execute command now requires `sessionKind` and `workspaceSeedKind`,
read by that tenant-scoped claim. Both are immutable resource metadata, not
authority credentials or a second state cache. Runner seed preparation and root
Tool construction use them without new PG reads. Deploy the paired Worker
components together; there is no legacy-command fallback or data migration.

Claim, lease, publication opening, started and running remain separate durable
boundaries. State-transition writes share a data-modifying CTE, with all prior
lock/CAS and transition-record checks retained. No database transaction waits on
Kafka, a provider or guest execution. No acknowledgement is weakened.

Each existing database pool retains at most two warm physical connections within
its configured maximum. Excess idle/broken connections are still retired. Plans
remain per-connection, bounded and value-independent; no global generic-plan
override, additional pool or external cache is introduced.
