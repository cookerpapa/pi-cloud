# PiCloud deterministic fault evaluation

Generated: 2026-09-26T17:17:24.351Z

Revision: 9a3b60f424661800ef5c84bf56f88bb025453158

Uncommitted changes at test start: yes

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 65
- File-group executions: 28; total wall time: 194297 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 65/65 (100.0%)
- p50 / p95: 101 ms / 4689 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| native-late-input-drain | pass | Accepted late native input continues within the same operation before successful Run closure. | 15 ms |
| native-final-append-input-fence | pass | Waiting for final durable append cannot reopen control-input admission. | 4 ms |
| native-followup-retry-reset | pass | A successful sampling response resets retry state before a subsequent input's sampling. | 14 ms |
| native-compaction-usage-freshness | pass | A retained pre-compaction usage value cannot force another threshold compaction. | 3 ms |
| native-cancel-retry-backoff | pass | Run cancellation interrupts retry backoff without another model call or shared-authority revocation. | 8 ms |
| expired-owner-at-run-admission | pass | Final admission checks current PG time after locks; an expired lease cannot start the Agent or leave partial owner state. | 101 ms |
| cancel-native-projection-locks | pass | Cancellation lifecycle locks remain compatible with the native Record's Turn foreign key, so neither side deadlocks. | 327 ms |
| cancel-settlement-sql-abort | pass | A certified cancellation-settlement SQL abort retries only that transaction, never the external stop or Agent Loop. | 408 ms |
| ready-seal-atomicity | pass | A failed seal commit cannot release the next Lane task or decrement the family count; replay decrements once. | 224 ms |
| ready-input-before-seal | pass | Input acceptance and seal projection serialize on the Lane row and cannot leave a committed follow-up permanently waiting. | 598 ms |
| ready-seal-before-input | pass | Input waiting behind a seal transaction observes the committed closure and becomes ready without another notification. | 361 ms |
| first-record-commit-reply-loss | pass | A lost PG COMMIT reply preserves the first recovery floor and idempotent native projection. | 181 ms |
| first-record-rollback | pass | First native data and its recovery floor roll back together, and retry cannot skip the prefix. | 210 ms |
| worker-local-pending-capacity | pass | Local pending reservations bound overlapping claims without a PG slot counter; successors still wait for closure. | 910 ms |
| ready-family-owner-handoff | pass | A ready main Lane cannot acquire a new owner until the old sibling's final seal commits. | 8169 ms |
| message-level-display-recovery | pass | Committed text leaves live memory before the Run ends; an unfinished suffix remains exact after failure. | 279 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 141 ms |
| seal-before-successor-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 278 ms |
| projector-prefix-rebuild | pass | A replacement Projector reconstructs the unsealed prefix without repeating native mutations. | 140 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 15 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 9 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 2 ms |
| stale-accepted-fact-authority | pass | Only the recorded execution scope is projectable; no standalone opening is required. | 5 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 134 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 7173 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 4 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 269 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 415 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 70 ms |
| tool-broker-owner-fence | pass | A replacement Tool Broker fences the expired owner before serving its Workspace runtime. | 6630 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 11 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 12 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 2 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 3 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 55 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 4689 ms |
| projector-owner-ack-loss | pass | A failed seal delivery retries its positioned control record without emitting the terminal twice; Tool command delivery is not retried. | 2 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 54 ms |
| tool-commit-before-effect | pass | A Tool command cannot dispatch until Kafka confirms its monotonic commit boundary. | 13 ms |
| tool-replay-without-effect | pass | Rebuilding volatile display state does not replay already committed Tool commands. | 16 ms |
| tool-native-late-result | pass | Completing guest work after closure cannot publish a usable native Tool result. | 7 ms |
| image-cleanup-composite-identity | pass | Image cleanup mutates only the tenant/object identities it locked, preserving another tenant's unexpired object. | 33 ms |
| image-upload-and-cleanup-failure | pass | Failed uploads cannot be retained; cleanup claims survive remote deletion failure. | 55 ms |
| image-unprojected-retention | pass | Kafka-acknowledged but unprojected images remain protected by their unsealed source Run. | 143 ms |
| image-cleanup-reference-race | pass | A deleting attachment cannot gain a canonical native reference. | 30 ms |
| image-cross-tenant-integrity | pass | A hash or tenant mismatch never becomes a successful native image. | 13 ms |
| image-native-fork-retention | pass | Cold reads and independent native Fork history retain the exact image bytes. | 191 ms |
| tool-reply-publication-failure | pass | Failed publication retires the pending image-adapter callback without crashing unrelated Worker families. | 10 ms |
| tool-reply-before-publication-ack | pass | Early reply rejection stays observed until command publication settles and never triggers an effect replay. | 2 ms |
| tool-reply-progress-rejected | pass | Observation-only progress cannot enter the final-result Kafka transport. | 2 ms |
| tool-reply-worker-loss | pass | A replacement Worker cannot attach an old operation's replies to a new Tool call. | 0 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 52 ms |
| gitlab-note-business-lock-release | pass | Provider HTTP holds no business transaction or row lock; one current note-sync claim does not block claim changes or ordinary Run admission. | 334 ms |
| gitlab-note-uncertain-create | pass | An uncertain remote create remains pending; marker readback recovers the applied note without repeating its creation in the tested lost-reply case. | 128 ms |
| gitlab-note-late-write | pass | Local claim fencing rejects a stale acknowledgement, and periodic remote verification repairs its late external write even after PG considered the latest version synced. | 180 ms |
| gitlab-note-ack-expiry | pass | Synchronization acknowledgement uses PG decision time after locking; a lease that expires while waiting cannot confirm remote output. | 594 ms |
| native-record-oversize-isolation | pass | Oversized individual publications fail before entering the shared Kafka Producer stream. | 10 ms |
| queued-edit-claim-race | pass | An admitted/locked Run cannot have its input rewritten by a pending edit. | 179 ms |
| queued-cancel-claim-race | pass | Pending cancellation cannot retire a Run whose admission already won. | 156 ms |
| queued-reorder-claim-race | pass | A locked queue neighbor cannot be reordered under an active admission. | 131 ms |
| queued-steer-lost-reply | pass | Canonical input consumption resolves a lost HTTP reply without executing the queued source. | 381 ms |
| queued-steer-seal-restore | pass | A missing reply alone cannot restore a queued source; an absent input plus projected seal can. | 282 ms |
| queued-steer-order | pass | Promotions to the same target preserve accepted delivery order across replicas. | 308 ms |
| queued-steer-shutdown | pass | Shutdown starts no further deliveries and restart finds the remaining durable controls. | 505 ms |
| queued-mutation-idempotency | pass | Concurrent API replicas cannot repeat a queue operation or silently overwrite a stale edit. | 88 ms |
