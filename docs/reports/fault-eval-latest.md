# PiCloud deterministic fault evaluation

Generated: 2026-08-30T16:35:43.621Z

Revision: 133dfab76b08936bcab8bb96e133a1212d18a604

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 4292 ms / 10808 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 7001 ms |
| stale-execution-lease | pass | A released Worker cannot reuse an obsolete ExecutionLease. | 3845 ms |
| stale-accepted-fact-authority | pass | Only the current PostgreSQL ExecutionLease can admit CandidateFacts into the durable log. | 6179 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 8091 ms |
| session-projection-barrier-before-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 1583 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 7909 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 8987 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 2828 ms |
| multiplexed-fact-reconnect | pass | One broken Worker transport reconnects logical Fact Streams without changing their authorities. | 2180 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 4292 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 10808 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 8818 ms |
| tool-broker-owner-fence | pass | A replacement Tool Broker fences the expired owner before serving its Workspace runtime. | 9602 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 3302 ms |
| stale-workspace-settlement | pass | A stale or foreign settlement cannot become the Workspace head. | 2711 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 3197 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 2982 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 9760 ms |
