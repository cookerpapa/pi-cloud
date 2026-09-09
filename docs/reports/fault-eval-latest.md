# PiCloud deterministic fault evaluation

Generated: 2026-09-09T14:51:46.419Z

Revision: 59b0ea55e9ec9cfee49602f53cd6c205f4341708

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 22
- Invariants preserved: 22/22 (100.0%)
- p50 / p95: 5150 ms / 14138 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| message-level-display-recovery | pass | Committed text leaves live memory before the Run ends; an unfinished suffix remains exact after failure. | 15179 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 1118 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 3362 ms |
| stale-execution-lease | pass | A released Worker cannot reuse an obsolete ExecutionLease. | 3658 ms |
| stale-accepted-fact-authority | pass | Only the recorded execution scope after its opening is projectable; no per-delta authority query. | 5140 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 11462 ms |
| seal-before-successor-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 12399 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 8380 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 14138 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 734 ms |
| projector-prefix-rebuild | pass | A replacement Projector reconstructs the unsealed prefix without repeating native mutations. | 11627 ms |
| opening-commit-reply-loss | pass | A lost PG COMMIT reply cannot poison opening state or cause later records to be skipped. | 5150 ms |
| opening-rollback | pass | An opening is effective only after its transaction commits, and retries can make progress. | 5158 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 3459 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 12048 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 9439 ms |
| tool-broker-owner-fence | pass | A replacement Tool Broker fences the expired owner before serving its Workspace runtime. | 7448 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 1479 ms |
| stale-workspace-settlement | pass | A stale or foreign settlement cannot become the Workspace head. | 1506 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 1446 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 1505 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 5805 ms |
