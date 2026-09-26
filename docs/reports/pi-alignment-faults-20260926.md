# PiCloud deterministic fault evaluation

Generated: 2026-09-26T02:51:32.769Z

Revision: ad1aad5fba4aba2f61320283f374fc6ccf6688f5

Uncommitted changes at test start: yes

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 38
- File-group executions: 22; total wall time: 134385 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 38/38 (100.0%)
- p50 / p95: 97 ms / 6782 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| expired-owner-at-run-admission | pass | Final admission checks current PG time after locks; an expired lease cannot start the Agent or leave partial owner state. | 97 ms |
| cancel-native-projection-locks | pass | Cancellation lifecycle locks remain compatible with the native Record's Turn foreign key, so neither side deadlocks. | 303 ms |
| cancel-settlement-sql-abort | pass | A certified cancellation-settlement SQL abort retries only that transaction, never the external stop or Agent Loop. | 333 ms |
| ready-seal-atomicity | pass | A failed seal commit cannot release the next Lane task or decrement the family count; replay decrements once. | 246 ms |
| ready-input-before-seal | pass | Input acceptance and seal projection serialize on the Lane row and cannot leave a committed follow-up permanently waiting. | 428 ms |
| ready-seal-before-input | pass | Input waiting behind a seal transaction observes the committed closure and becomes ready without another notification. | 287 ms |
| first-record-commit-reply-loss | pass | A lost PG COMMIT reply preserves the first recovery floor and idempotent native projection. | 143 ms |
| first-record-rollback | pass | First native data and its recovery floor roll back together, and retry cannot skip the prefix. | 206 ms |
| worker-local-pending-capacity | pass | Local pending reservations bound overlapping claims without a PG slot counter; successors still wait for closure. | 740 ms |
| ready-family-owner-handoff | pass | A ready main Lane cannot acquire a new owner until the old sibling's final seal commits. | 7058 ms |
| message-level-display-recovery | pass | Committed text leaves live memory before the Run ends; an unfinished suffix remains exact after failure. | 367 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 166 ms |
| seal-before-successor-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 307 ms |
| projector-prefix-rebuild | pass | A replacement Projector reconstructs the unsealed prefix without repeating native mutations. | 159 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 13 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 9 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 2 ms |
| stale-accepted-fact-authority | pass | Only the recorded execution scope is projectable; no standalone opening is required. | 4 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 104 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 6190 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 4 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 229 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 362 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 52 ms |
| tool-broker-owner-fence | pass | A replacement Tool Broker fences the expired owner before serving its Workspace runtime. | 6782 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 11 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 12 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 2 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 3 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 54 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 4680 ms |
| projector-owner-ack-loss | pass | A failed seal delivery retries its positioned control record without emitting the terminal twice; Tool command delivery is not retried. | 2 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 54 ms |
| tool-commit-before-effect | pass | A Tool command cannot dispatch until Kafka confirms its monotonic commit boundary. | 12 ms |
| tool-replay-without-effect | pass | Rebuilding volatile display state does not replay already committed Tool commands. | 15 ms |
| tool-native-late-result | pass | Completing guest work after closure cannot publish a usable native Tool result. | 8 ms |
| tool-reply-worker-loss | pass | A replacement Worker cannot attach an old operation's replies to a new Tool call. | 2 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 54 ms |
