# PiCloud deterministic fault evaluation

Generated: 2026-10-02T03:00:09.911Z

Revision: 743499906e2561e671d864da54f90fb918d97498

Uncommitted changes at test start: yes

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 116
- File-group executions: 44; total wall time: 312577 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 116/116 (100.0%)
- p50 / p95: 56 ms / 5635 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| execution-probe-no-allocation | pass | Probes never allocate a VM; an expected missing binding is unavailable, not silently not-applicable. | 56 ms |
| execution-probe-fast-reply | pass | A fast complete return cannot be overwritten by a later admission receipt. | 103 ms |
| execution-probe-stale-identity | pass | Current scope, target and deadline are required for fresh evidence; unknown transport never authorizes resource recovery. | 52 ms |
| execution-probe-projector-reset | pass | Pending observations cannot survive Projector ownership reset as fresh acknowledgements. | 53 ms |
| runtime-probe-partial-inventory | pass | Partial inventory or failed guest responses cannot authorize VM destruction or quota release. | 1 ms |
| runtime-probe-fleet-coverage | pass | Every due physical runtime is examined without a 16-item truncation or unbounded concurrent requests. | 69 ms |
| execution-probe-independent-paths | pass | Missing guest replies do not block publication, native drain or future log-path probes; replaced bindings reject late evidence. | 13 ms |
| path-probe-stalled-ack | pass | At most one probe is outstanding per physical Session; a probe has no semantic commit to recover. | 4 ms |
| machine-rebind-release-race | pass | A pending machine release wins over a stale target lookup; rebinding checks a fresh snapshot after the machine lock. | 183 ms |
| machine-rebind-identity-and-retry | pass | Binding replay cannot duplicate or retarget the operation; native Session/model identity and previously accepted Run snapshots remain unchanged. | 283 ms |
| lease-sweep-independent-of-retirement | pass | A stalled remote stop cannot stall lease scanning; drain prevents another cleanup claim. | 34 ms |
| lease-sweep-pg-time | pass | Both initial expiry selection and final retirement use PG time, independent of API clock skew. | 5560 ms |
| path-probe-stale-replay | pass | A replay or stale probe cannot refresh liveness or create an active execution scope. | 7 ms |
| activity-writer-seal | pass | Tenant, partition and owner checks fence phase observations; a writer seal closes all sibling observations. | 5 ms |
| activity-terminal-sse | pass | Transient activity cannot alter transcript sequence or reopen a terminal turn. | 7 ms |
| upload-expiry-late-completion | pass | Expired drafts release image pins; a revoked upload cannot become a ready input after a late external reply. | 195 ms |
| upload-capacity-gc-race | pass | Binary upload admission is bounded before buffering; image pinning cannot acknowledge a GC-deleted source. | 135 ms |
| upload-symlink-confinement | pass | Upload placement cannot follow a substituted directory or destination link outside the authorized root. | 57 ms |
| input-image-guest-cancel | pass | Input preparation is fenced independently of Agent Tool execution and remains tracked until guest cancellation finishes. | 42 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 8 ms |
| cancel-stop-failure | pass | Cancellation revokes Tool authority before uncertain process cleanup returns. | 5 ms |
| shared-runtime-loss | pass | Loss of one Workspace Cube cannot leave a surviving logical Tool binding. | 7 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 54 ms |
| native-proved-rejection | pass | A proved pre-enqueue rejection restores committed state and preserves sibling publication and contiguous sequence. | 8 ms |
| cancel-queued-native-publication | pass | Cancellation while waiting for the Session writer neither publishes the invocation nor consumes a native sequence. | 2 ms |
| projection-independent-cancel | pass | Cancelling a cold history waiter does not cancel the shared progress read or a sibling. | 54 ms |
| projection-owner-cache-fence | pass | Previously observed progress cannot authorize a retired owner or cache a failed read. | 25 ms |
| projection-lock-timeout-replay | pass | Server lock timeout leaves native history and projection positions unchanged; redelivery after release applies once. | 447 ms |
| projection-statement-timeout | pass | A timed-out SQL statement rolls back preceding writes and transaction-local timeout settings. | 163 ms |
| expired-owner-at-run-admission | pass | Final admission checks current PG time after locks; an expired lease cannot start the Agent or leave partial owner state. | 102 ms |
| cancel-native-projection-locks | pass | Cancellation lifecycle locks remain compatible with the native Record's Turn foreign key, so neither side deadlocks. | 313 ms |
| cancel-settlement-sql-abort | pass | A certified cancellation-settlement SQL abort retries only that transaction, never the external stop or Agent Loop. | 314 ms |
| ready-seal-atomicity | pass | A failed seal commit cannot release the next Lane task or decrement the family count; replay decrements once. | 178 ms |
| ready-input-before-seal | pass | Input acceptance and seal projection serialize on the Lane row and cannot leave a committed follow-up permanently waiting. | 317 ms |
| ready-seal-before-input | pass | Input waiting behind a seal transaction observes the committed closure and becomes ready without another notification. | 292 ms |
| first-record-commit-reply-loss | pass | A lost PG COMMIT reply preserves the first recovery floor and idempotent native projection. | 161 ms |
| first-record-rollback | pass | First native data and its recovery floor roll back together, and retry cannot skip the prefix. | 173 ms |
| projection-other-partition-progress | pass | A blocked delivery in one partition does not serialize unrelated partition handlers. | 52 ms |
| atomic-tool-replay | pass | Native intent projects before effect admission; replay never reissues the combined command. | 63 ms |
| atomic-tool-projection-failure | pass | Failed native projection cannot commit or dispatch its Tool command. | 5 ms |
| atomic-tool-commit-failure | pass | An unconfirmed Kafka dispatch commit cannot issue a Tool effect. | 2 ms |
| atomic-tool-rebalance | pass | Lost partition ownership after commit does not dispatch a new effect. | 1 ms |
| atomic-tool-seal | pass | An invocation after its scope seal cannot dispatch a Tool command. | 1 ms |
| projector-seal-replay | pass | Seal projection replay cannot duplicate a terminal or repeat execution closure; closure precedes publication. | 1 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 1 ms |
| native-late-input-drain | pass | Accepted late native input continues within the same operation before successful Run closure. | 13 ms |
| native-final-append-input-fence | pass | Waiting for final durable append cannot reopen control-input admission. | 3 ms |
| native-followup-retry-reset | pass | A successful sampling response resets retry state before a subsequent input's sampling. | 12 ms |
| native-compaction-usage-freshness | pass | A retained pre-compaction usage value cannot force another threshold compaction. | 2 ms |
| native-cancel-retry-backoff | pass | Run cancellation interrupts retry backoff without another model call or shared-authority revocation. | 5 ms |
| worker-local-pending-capacity | pass | Local pending reservations bound overlapping claims without a PG slot counter; successors still wait for closure. | 802 ms |
| ready-family-owner-handoff | pass | A ready main Lane cannot acquire a new owner until the old sibling's final seal commits. | 9244 ms |
| message-level-display-recovery | pass | Committed text leaves live memory before the Run ends; an unfinished suffix remains exact after failure. | 335 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 202 ms |
| seal-before-successor-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 320 ms |
| projector-prefix-rebuild | pass | A replacement Projector reconstructs the unsealed prefix without repeating native mutations. | 194 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 41 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 8 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 2 ms |
| stale-accepted-fact-authority | pass | A record cannot install its own authority or bypass the PG-issued publication scope. | 1 ms |
| native-record-oversize-isolation | pass | Oversized individual publications fail before entering the bounded publication queue. | 5 ms |
| publication-seal-order | pass | Ingress closes old admission before draining and a successor cannot pass the ordered seal. | 112 ms |
| publication-stale-admission | pass | A delayed PG grant cannot reopen a scope after its closure completed. | 1 ms |
| publication-uncertain-queued-data | pass | Unknown semantic commit stops queued data while preserving ordered closure. | 1 ms |
| publication-lost-seal-ack | pass | PG canonical seal evidence releases a successor despite a lost producer ACK. | 1 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 98 ms |
| native-subagent-result-budget | pass | The native Harness persists a result-size Tool error and can finish the next model Step normally. | 133 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 9122 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 7 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 297 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 411 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 94 ms |
| sandbox-control-owner-fence | pass | A replacement Sandbox control fences the expired owner before serving its Workspace runtime. | 7829 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 7 ms |
| quarantined-binding-late-command | pass | Durable binding closure rejects late Tool handoffs even after stopping is unconfirmed and the dispatcher is replaced. | 2 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 5635 ms |
| tool-commit-before-effect | pass | A Tool command cannot dispatch until Kafka confirms its monotonic commit boundary. | 12 ms |
| tool-replay-without-effect | pass | Rebuilding volatile display state does not replay already committed Tool commands. | 14 ms |
| tool-native-late-result | pass | Completing guest work after closure cannot publish a usable native Tool result. | 10 ms |
| image-cleanup-composite-identity | pass | Image cleanup mutates only the tenant/object identities it locked, preserving another tenant's unexpired object. | 34 ms |
| image-upload-and-cleanup-failure | pass | Failed uploads cannot be retained; cleanup claims survive remote deletion failure. | 58 ms |
| image-unprojected-retention | pass | Kafka-acknowledged but unprojected images remain protected by their unsealed source Run. | 135 ms |
| image-cleanup-reference-race | pass | A deleting attachment cannot gain a canonical native reference. | 28 ms |
| image-cross-tenant-integrity | pass | A hash or tenant mismatch never becomes a successful native image. | 14 ms |
| image-native-fork-retention | pass | Cold reads and independent native Fork history retain the exact image bytes. | 288 ms |
| tool-reply-publication-failure | pass | Failed publication retires the pending image-adapter callback without crashing unrelated Worker families. | 12 ms |
| tool-reply-before-publication-ack | pass | Early reply rejection stays observed until command publication settles and never triggers an effect replay. | 2 ms |
| tool-reply-progress-rejected | pass | Observation-only progress cannot enter the final-result Kafka transport. | 4 ms |
| tool-reply-worker-loss | pass | A replacement Worker cannot attach an old operation's replies to a new Tool call. | 1 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 55 ms |
| gitlab-note-business-lock-release | pass | Provider HTTP holds no business transaction or row lock; one current note-sync claim does not block claim changes or ordinary Run admission. | 447 ms |
| gitlab-note-uncertain-create | pass | An uncertain remote create remains pending; marker readback recovers the applied note without repeating its creation in the tested lost-reply case. | 160 ms |
| gitlab-note-late-write | pass | Local claim fencing rejects a stale acknowledgement, and periodic remote verification repairs its late external write even after PG considered the latest version synced. | 231 ms |
| gitlab-note-ack-expiry | pass | Synchronization acknowledgement uses PG decision time after locking; a lease that expires while waiting cannot confirm remote output. | 629 ms |
| queued-edit-claim-race | pass | An admitted/locked Run cannot have its input rewritten by a pending edit. | 141 ms |
| queued-cancel-claim-race | pass | Pending cancellation cannot retire a Run whose admission already won. | 139 ms |
| queued-reorder-claim-race | pass | A locked queue neighbor cannot be reordered under an active admission. | 143 ms |
| queued-steer-lost-reply | pass | Canonical input consumption resolves a lost HTTP reply without executing the queued source. | 219 ms |
| queued-steer-seal-restore | pass | A missing reply alone cannot restore a queued source; an absent input plus projected seal can. | 234 ms |
| queued-steer-order | pass | Promotions to the same target preserve accepted delivery order across replicas. | 274 ms |
| queued-steer-shutdown | pass | Shutdown starts no further deliveries and restart finds the remaining durable controls. | 536 ms |
| queued-mutation-idempotency | pass | Concurrent API replicas cannot repeat a queue operation or silently overwrite a stale edit. | 84 ms |
| direct-steer-unconsumed-recovery | pass | A Worker acknowledgement never retires input; target closure restores unconsumed input without replaying its Run. | 661 ms |
| direct-steer-canonical-consumption | pass | Canonical input evidence wins over missing transport acknowledgement and prevents fallback execution. | 286 ms |
| direct-steer-late-reply | pass | A late Worker reply cannot overwrite a sealed-target restoration decision. | 260 ms |
| direct-steer-cancel-recovery | pass | Stopping the active Run retains unconsumed direct input and leaves its restored queue entry removable. | 376 ms |
| direct-steer-acceptance-race | pass | Direct Steer acceptance is atomic and idempotent under target locks and concurrent API replicas. | 328 ms |
| workflow-result-budget | pass | A completed oversized workflow return becomes an explicit bounded error without repeating effects. | 73 ms |
| lease-batch-renewal-race | pass | An older lookup cannot revoke ownership confirmed by a newer committed renewal. | 1 ms |
| lease-batch-one-second-revocation | pass | Sharing heartbeat evidence does not slow periodic PG revocation observation. | 8 ms |
| lease-batch-no-revival | pass | Missing renewal retires the reported family while retaining other families; later replies cannot revive it. | 2 ms |
| lease-batch-read-failure | pass | A failed batch read fails closed for every owner in that observation. | 1 ms |
| lease-batch-incarnation | pass | Closing a lease observer prevents stale reads from affecting a later local incarnation. | 1 ms |
| indexed-log-quiescent-cutover | pass | An unsettled Session prevents schema cutover; settled cutover retains immutable bodies and never resurrects deleted Turn bindings. | 8455 ms |
| native-open-operation-rollback | pass | Native open-operation references share the log transaction, preserve Lane/tenant scope and rebuild without re-executing effects. | 123 ms |
| direct-steer-fk-locks | pass | Input acceptance does not deadlock with active Tool binding foreign-key checks. | 8610 ms |
