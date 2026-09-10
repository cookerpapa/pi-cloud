# PiCloud deterministic fault evaluation

Generated: 2026-09-10T02:49:03.816Z

Revision: 2f57a7f6f6fe81f8f4e478155a573bcc1e0868a0

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 26
- Invariants preserved: 26/26 (100.0%)
- p50 / p95: 3988 ms / 14106 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| message-level-display-recovery | pass | Committed text leaves live memory before the Run ends; an unfinished suffix remains exact after failure. | 14106 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 1538 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 3891 ms |
| stale-execution-lease | pass | A released Worker cannot reuse an obsolete ExecutionLease. | 3387 ms |
| stale-accepted-fact-authority | pass | Only the recorded execution scope after its opening is projectable; no per-delta authority query. | 6083 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 13100 ms |
| seal-before-successor-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 12919 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 9096 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 14644 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 1006 ms |
| projector-prefix-rebuild | pass | A replacement Projector reconstructs the unsealed prefix without repeating native mutations. | 13036 ms |
| opening-commit-reply-loss | pass | A lost PG COMMIT reply cannot poison opening state or cause later records to be skipped. | 5761 ms |
| opening-rollback | pass | An opening is effective only after its transaction commits, and retries can make progress. | 5914 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 3988 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 13457 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 10641 ms |
| tool-broker-owner-fence | pass | A replacement Tool Broker fences the expired owner before serving its Workspace runtime. | 9223 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 2381 ms |
| stale-workspace-settlement | pass | A stale or foreign settlement cannot become the Workspace head. | 2421 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 2388 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 2540 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 8455 ms |
| projector-owner-ack-loss | pass | A failed owner delivery retries the same positioned record without emitting its live event twice; this test simulates PG/transport. | 2257 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 2247 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 2572 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 979 ms |
