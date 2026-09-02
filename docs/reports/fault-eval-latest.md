# PiCloud deterministic fault evaluation

Generated: 2026-09-02T05:07:23.769Z

Revision: 15d30f6b249e10d2251501cd834e05d797b4f72a

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 2687 ms / 7884 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 3477 ms |
| stale-execution-lease | pass | A released Worker cannot reuse an obsolete ExecutionLease. | 2572 ms |
| stale-accepted-fact-authority | pass | Only the current PostgreSQL ExecutionLease can admit CandidateFacts into the durable log. | 3950 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 5304 ms |
| session-projection-barrier-before-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 1220 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 5447 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 5327 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 1579 ms |
| multiplexed-fact-reconnect | pass | One broken Worker transport reconnects logical Fact Streams without changing their authorities. | 1292 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 2687 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 7884 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 6086 ms |
| tool-broker-owner-fence | pass | A replacement Tool Broker fences the expired owner before serving its Workspace runtime. | 6129 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 1755 ms |
| stale-workspace-settlement | pass | A stale or foreign settlement cannot become the Workspace head. | 1806 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 1801 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 1852 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 5713 ms |
