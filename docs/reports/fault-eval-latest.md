# PiCloud deterministic fault evaluation

Generated: 2026-09-16T02:18:34.176Z

Revision: 32e40930c375a5d456c803202650174cc366c5f0

Uncommitted changes at test start: no

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 26
- Invariants preserved: 26/26 (100.0%)
- p50 / p95: 3202 ms / 10238 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| message-level-display-recovery | pass | Committed text leaves live memory before the Run ends; an unfinished suffix remains exact after failure. | 9595 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 1366 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 2811 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 2530 ms |
| stale-accepted-fact-authority | pass | Only the recorded execution scope after its opening is projectable; no per-delta authority query. | 4663 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 10151 ms |
| seal-before-successor-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 10238 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 6998 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 10986 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 686 ms |
| projector-prefix-rebuild | pass | A replacement Projector reconstructs the unsealed prefix without repeating native mutations. | 10089 ms |
| opening-commit-reply-loss | pass | A lost PG COMMIT reply cannot poison opening state or cause later records to be skipped. | 4185 ms |
| opening-rollback | pass | An opening is effective only after its transaction commits, and retries can make progress. | 4595 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 2945 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 9724 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 7351 ms |
| tool-broker-owner-fence | pass | A replacement Tool Broker fences the expired owner before serving its Workspace runtime. | 6208 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 3190 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 2646 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 3074 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 2740 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 7288 ms |
| projector-owner-ack-loss | pass | A failed owner delivery retries the same positioned record without emitting its live event twice; this test simulates PG/transport. | 2490 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 3202 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 2648 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 613 ms |
