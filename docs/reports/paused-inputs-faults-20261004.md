# PiCloud deterministic fault evaluation

Generated: 2026-10-04T05:31:25.451Z

Revision: dd3897e54565e09f191adfa418b4e8061353e83e

Uncommitted changes at test start: no

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 172
- File-group executions: 61; total wall time: 290964 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 172/172 (100.0%)
- p50 / p95: 54 ms / 5716 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| execution-probe-no-allocation | pass | Probes never allocate a VM; an expected missing binding is unavailable, not silently not-applicable. | 55 ms |
| execution-probe-fast-reply | pass | A fast complete return cannot be overwritten by a later admission receipt. | 103 ms |
| execution-probe-stale-identity | pass | Current scope, target and deadline are required for fresh evidence; unknown transport never authorizes resource recovery. | 52 ms |
| execution-probe-projector-reset | pass | Pending observations cannot survive Projector ownership reset as fresh acknowledgements. | 52 ms |
| runtime-probe-partial-inventory | pass | Partial inventory or failed guest responses cannot authorize VM destruction or quota release. | 1 ms |
| runtime-probe-fleet-coverage | pass | Every due physical runtime is examined without a 16-item truncation or unbounded concurrent requests. | 60 ms |
| execution-probe-independent-paths | pass | Missing guest replies do not block publication, native drain or future log-path probes; replaced bindings reject late evidence. | 7 ms |
| path-probe-stalled-ack | pass | At most one probe is outstanding per physical Session; a probe has no semantic commit to recover. | 2 ms |
| machine-rebind-release-race | pass | A pending machine release wins over a stale target lookup; rebinding checks a fresh snapshot after the machine lock. | 103 ms |
| machine-rebind-identity-and-retry | pass | Binding replay cannot duplicate or retarget the operation; native Session/model identity and previously accepted Run snapshots remain unchanged. | 184 ms |
| lease-sweep-independent-of-retirement | pass | A stalled remote stop cannot stall lease scanning; drain prevents another cleanup claim. | 34 ms |
| lease-sweep-pg-time | pass | Both initial expiry selection and final retirement use PG time, independent of API clock skew. | 3581 ms |
| path-probe-stale-replay | pass | A replay or stale probe cannot refresh liveness or create an active execution scope. | 6 ms |
| activity-writer-seal | pass | Tenant, partition and owner checks fence phase observations; a writer seal closes all sibling observations. | 4 ms |
| activity-terminal-sse | pass | Transient activity cannot alter transcript sequence or reopen a terminal turn. | 5 ms |
| upload-expiry-late-completion | pass | Expired drafts release image pins; a revoked upload cannot become a ready input after a late external reply. | 159 ms |
| upload-stream-gc-pin | pass | Streaming uploads exceed former product quotas while image reachability is pinned before final publication; GC cannot remove an active source. | 283 ms |
| upload-stream-digest-rejection | pass | A declared content digest is verified against the actual stream before ready metadata is published. | 29 ms |
| upload-symlink-confinement | pass | Upload placement cannot follow a substituted directory or destination link outside the authorized root. | 45 ms |
| upload-stream-truncation-cancel | pass | Truncated, overlong or cancelled transfers leave no partial published file, including above the former upload size limit. | 938 ms |
| input-image-guest-cancel | pass | Input preparation is fenced independently of Agent Tool execution and remains tracked until guest cancellation finishes. | 30 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 3 ms |
| cancel-routing-publication-failure | pass | Agent cancellation revokes routing without stopping Cube processes; publication failure retains metadata and VM quota. | 53 ms |
| shared-runtime-loss | pass | A lost shared VM closes every binding and local admission even when closure publication is unavailable. | 3 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 53 ms |
| recovery-closure-pending | pass | Pending ordered closure neither quarantines a verified shared VM nor exposes partial local binding restoration. | 3 ms |
| native-proved-rejection | pass | A proved pre-enqueue rejection restores committed state and preserves sibling publication and contiguous sequence. | 5 ms |
| cancel-queued-native-publication | pass | Cancellation while waiting for the Session writer neither publishes the invocation nor consumes a native sequence. | 1 ms |
| projection-independent-cancel | pass | Cancelling a cold history waiter does not cancel the shared progress read or a sibling. | 53 ms |
| projection-owner-cache-fence | pass | Previously observed progress cannot authorize a retired owner or cache a failed read. | 25 ms |
| projection-lock-timeout-replay | pass | Server lock timeout leaves native history and projection positions unchanged; redelivery after release applies once. | 335 ms |
| projection-statement-timeout | pass | A timed-out SQL statement rolls back preceding writes and transaction-local timeout settings. | 130 ms |
| expired-owner-at-run-admission | pass | Final admission checks current PG time after locks; an expired lease cannot start the Agent or leave partial owner state. | 64 ms |
| cancel-native-projection-locks | pass | Cancellation lifecycle locks remain compatible with the native Record's Turn foreign key, so neither side deadlocks. | 218 ms |
| cancel-settlement-sql-abort | pass | A certified cancellation-settlement SQL abort retries only that transaction, never the external stop or Agent Loop. | 331 ms |
| ready-seal-atomicity | pass | A failed seal commit cannot release the next Lane task or decrement the family count; replay decrements once. | 150 ms |
| ready-input-before-seal | pass | Input acceptance and seal projection serialize on the Lane row and cannot leave a committed follow-up permanently waiting. | 274 ms |
| ready-seal-before-input | pass | Input waiting behind a seal transaction observes the committed closure and becomes ready without another notification. | 262 ms |
| first-record-commit-reply-loss | pass | A lost PG COMMIT reply preserves the first recovery floor and idempotent native projection. | 129 ms |
| first-record-rollback | pass | First native data and its recovery floor roll back together, and retry cannot skip the prefix. | 150 ms |
| projection-other-partition-progress | pass | A blocked delivery in one partition does not serialize unrelated partition handlers. | 52 ms |
| atomic-tool-replay | pass | Native intent projects before effect admission; replay never reissues the combined command. | 57 ms |
| atomic-tool-projection-failure | pass | Failed native projection cannot commit or dispatch its Tool command. | 2 ms |
| atomic-tool-commit-failure | pass | An unconfirmed Kafka dispatch commit cannot issue a Tool effect. | 1 ms |
| atomic-tool-rebalance | pass | Lost partition ownership after commit does not dispatch a new effect. | 1 ms |
| atomic-tool-seal | pass | An invocation after its scope seal cannot dispatch a Tool command. | 1 ms |
| projector-seal-replay | pass | Seal projection replay cannot duplicate a terminal or repeat execution closure; closure precedes publication. | 1 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 1 ms |
| native-late-input-drain | pass | Accepted late native input continues within the same operation before successful Run closure. | 8 ms |
| native-final-append-input-fence | pass | Waiting for final durable append cannot reopen control-input admission. | 2 ms |
| native-followup-retry-reset | pass | A successful sampling response resets retry state before a subsequent input's sampling. | 8 ms |
| native-compaction-usage-freshness | pass | A retained pre-compaction usage value cannot force another threshold compaction. | 1 ms |
| native-cancel-retry-backoff | pass | Run cancellation interrupts retry backoff without another model call or shared-authority revocation. | 3 ms |
| worker-local-pending-capacity | pass | Local pending reservations bound overlapping claims without a PG slot counter; successors still wait for closure. | 669 ms |
| ready-family-owner-handoff | pass | A ready main Lane cannot acquire a new owner until the old sibling's final seal commits. | 5936 ms |
| cancel-pg-clock | pass | PG due time, claims and retries remain correct under application clock skew and concurrent dispatch. | 6169 ms |
| message-level-display-recovery | pass | Committed text leaves live memory before the Run ends; an unfinished suffix remains exact after failure. | 194 ms |
| session-mutation-redelivery | pass | Kafka redelivery creates one canonical Pi Session mutation. | 110 ms |
| seal-before-successor-read | pass | A replacement Worker observes every older accepted Session mutation before reading context. | 171 ms |
| projector-prefix-rebuild | pass | A replacement Projector reconstructs the unsealed prefix without repeating native mutations. | 105 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 25 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 7 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 1 ms |
| stale-accepted-fact-authority | pass | A record cannot install its own authority or bypass the PG-issued publication scope. | 1 ms |
| native-record-oversize-isolation | pass | Oversized individual publications fail before entering the bounded publication queue. | 4 ms |
| publication-seal-order | pass | Ingress closes old admission before draining and a successor cannot pass the ordered seal. | 107 ms |
| publication-stale-admission | pass | A delayed PG grant cannot reopen a scope after its closure completed. | 0 ms |
| publication-uncertain-queued-data | pass | Unknown semantic commit stops queued data while preserving ordered closure. | 1 ms |
| publication-lost-seal-ack | pass | PG canonical seal evidence releases a successor despite a lost producer ACK. | 1 ms |
| message-stream-independence | pass | A live-stream failure cannot roll back a complete native Pi message. | 63 ms |
| native-subagent-result-budget | pass | The native Harness persists a result-size Tool error and can finish the next model Step normally. | 85 ms |
| agent-stop-publication-ack | pass | The Agent awaits cancellation settlement of an already-published Tool, retains its output, and makes no later model request. | 69 ms |
| agent-stop-reply-wait | pass | The Agent awaits cancellation settlement of an already-published Tool, retains its output, and makes no later model request. | 66 ms |
| queue-stop-native-steer | pass | A cancelled Tool cannot drain pending native input into history; the durable source remains available for consumption-confirmed restoration. | 41 ms |
| queue-stop-native-follow-up | pass | A cancelled Tool cannot drain pending native input into history; the durable source remains available for consumption-confirmed restoration. | 42 ms |
| interrupted-visible-prefix | pass | A browser-visible interrupted prefix remains model-visible after Worker replacement. | 4624 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 3 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 172 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 341 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 55 ms |
| sandbox-control-owner-fence | pass | A replacement Sandbox control fences the expired owner before serving its Workspace runtime. | 5604 ms |
| quarantine-stale-physical-target | pass | A delayed old VM quarantine cannot rewrite its replacement identity or close replacement bindings. | 5720 ms |
| binding-view-owned-capacity | pass | Foreign partition payloads do not consume owner bootstrap row or byte budgets. | 5880 ms |
| agent-routing-retirement | pass | Routing retirement requires closure, isolates the exact Run even with a shared binding ID, and requires no Cube process receipt. | 5716 ms |
| controller-shutdown-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 5566 ms |
| controller-expiry-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 5832 ms |
| adoption-notification-outage | pass | Verified VM adoption and confirmed binding retirement survive notification outages through durable Outbox propagation. | 5453 ms |
| tool-cancel-retired-binding | pass | Durable cleanup intent survives Worker loss and routing-row retirement without a process-stop receipt table. | 5593 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 1 ms |
| quarantined-binding-late-command | pass | Durable routing closure rejects later Tool handoffs after dispatcher replacement without cancelling previously accepted processes. | 1 ms |
| tool-cancel-revoked-route | pass | Routing revocation blocks new work without blocking idempotent cancellation of an existing operation. | 3 ms |
| tool-cancel-unavailable-executor | pass | Executor communication failure never authorizes VM deletion or shell replay. | 1 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 3857 ms |
| tool-commit-before-effect | pass | A Tool command cannot dispatch until Kafka confirms its monotonic commit boundary. | 13 ms |
| tool-replay-without-effect | pass | Rebuilding volatile display state does not replay already committed Tool commands. | 14 ms |
| tool-native-late-result | pass | Completing guest work after closure cannot publish a usable native Tool result. | 7 ms |
| image-cleanup-composite-identity | pass | Image cleanup mutates only the tenant/object identities it locked, preserving another tenant's unexpired object. | 34 ms |
| image-upload-and-cleanup-failure | pass | Failed uploads cannot be retained; cleanup claims survive remote deletion failure. | 72 ms |
| image-unprojected-retention | pass | Kafka-acknowledged but unprojected images remain protected by their unsealed source Run. | 101 ms |
| image-cleanup-reference-race | pass | A deleting attachment cannot gain a canonical native reference. | 24 ms |
| image-cross-tenant-integrity | pass | A hash or tenant mismatch never becomes a successful native image. | 12 ms |
| image-native-fork-retention | pass | Cold reads and independent native Fork history retain the exact image bytes. | 225 ms |
| input-image-consumer-closure | pass | Consumer failure/early return never certifies an incomplete image and closes its source. | 18 ms |
| tool-reply-publication-failure | pass | Failed publication retires the pending image-adapter callback without crashing unrelated Worker families. | 8 ms |
| tool-reply-before-publication-ack | pass | Early reply rejection stays observed until command publication settles and never triggers an effect replay. | 2 ms |
| tool-cancel-adapter-wiring | pass | Runtime normalization must retain the cancellation publisher and settlement budget; transport acceptance never replaces the final result. | 54 ms |
| tool-reply-progress-rejected | pass | Observation-only progress cannot enter the final-result Kafka transport. | 2 ms |
| tool-reply-worker-loss | pass | A replacement Worker cannot attach an old operation's replies to a new Tool call. | 0 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 53 ms |
| gitlab-note-business-lock-release | pass | Provider HTTP holds no business transaction or row lock; one current note-sync claim does not block claim changes or ordinary Run admission. | 266 ms |
| gitlab-note-uncertain-create | pass | An uncertain remote create remains pending; marker readback recovers the applied note without repeating its creation in the tested lost-reply case. | 118 ms |
| gitlab-note-late-write | pass | Local claim fencing rejects a stale acknowledgement, and periodic remote verification repairs its late external write even after PG considered the latest version synced. | 142 ms |
| gitlab-note-ack-expiry | pass | Synchronization acknowledgement uses PG decision time after locking; a lease that expires while waiting cannot confirm remote output. | 557 ms |
| queued-edit-claim-race | pass | An admitted/locked Run cannot have its input rewritten by a pending edit. | 116 ms |
| queued-cancel-claim-race | pass | Pending cancellation cannot retire a Run whose admission already won. | 133 ms |
| queued-reorder-claim-race | pass | A locked queue neighbor cannot be reordered under an active admission. | 110 ms |
| queued-steer-lost-reply | pass | Canonical input consumption resolves a lost HTTP reply without executing the queued source. | 155 ms |
| queued-steer-seal-restore | pass | A missing reply alone cannot restore a queued source; an absent input plus projected seal can. | 200 ms |
| queued-steer-order | pass | Promotions to the same target preserve accepted delivery order across replicas. | 199 ms |
| queued-steer-shutdown | pass | Shutdown starts no further deliveries and restart finds the remaining durable controls. | 478 ms |
| queued-mutation-idempotency | pass | Concurrent API replicas cannot repeat a queue operation or silently overwrite a stale edit. | 69 ms |
| direct-steer-unconsumed-recovery | pass | A Worker acknowledgement never retires input; target closure restores unconsumed input without replaying its Run. | 315 ms |
| direct-steer-canonical-consumption | pass | Canonical input evidence wins over missing transport acknowledgement and prevents fallback execution. | 174 ms |
| direct-steer-late-reply | pass | A late Worker reply cannot overwrite a sealed-target restoration decision. | 150 ms |
| direct-steer-cancel-recovery | pass | Stopping the active Run retains unconsumed direct input and leaves its restored queue entry removable. | 238 ms |
| direct-steer-acceptance-race | pass | Direct Steer acceptance is atomic and idempotent under target locks and concurrent API replicas. | 147 ms |
| steer-acked-scope-recovery | pass | An HTTP ACK cannot retire pending native input; cold recovery and canonical wakes still reconcile it. | 1343 ms |
| queue-page-version | pass | Paging never mixes queue orders or limits the count of durable inputs. | 743 ms |
| queue-stop-durable-pause | pass | Stop is durable; new input bypasses paused intents and explicit continuation preserves execution/history order and frozen attachments. | 542 ms |
| queue-stop-steer-unconsumed | pass | An unconsumed Steer survives Stop as a paused input and cannot execute after service reconstruction. | 252 ms |
| queue-stop-steer-consumed | pass | Canonical consumption wins a Stop race; consumed input is not restored or executed again. | 237 ms |
| queue-resume-retry-isolation | pass | Server-side continuation covers all pages; stale commands conflict and old retries cannot undo a later pause. | 461 ms |
| workflow-result-budget | pass | A completed oversized workflow return becomes an explicit bounded error without repeating effects. | 43 ms |
| lease-batch-renewal-race | pass | An older lookup cannot revoke ownership confirmed by a newer committed renewal. | 0 ms |
| lease-batch-one-second-revocation | pass | Sharing heartbeat evidence does not slow periodic PG revocation observation. | 5 ms |
| lease-batch-no-revival | pass | Missing renewal retires the reported family while retaining other families; later replies cannot revive it. | 1 ms |
| lease-batch-read-failure | pass | A failed batch read fails closed for every owner in that observation. | 1 ms |
| lease-batch-incarnation | pass | Closing a lease observer prevents stale reads from affecting a later local incarnation. | 1 ms |
| indexed-log-quiescent-cutover | pass | An unsettled Session prevents schema cutover; settled cutover retains immutable bodies and never resurrects deleted Turn bindings. | 5811 ms |
| native-open-operation-rollback | pass | Native open-operation references share the log transaction, preserve Lane/tenant scope and rebuild without re-executing effects. | 77 ms |
| direct-steer-fk-locks | pass | Input acceptance does not deadlock with active Tool binding foreign-key checks. | 5792 ms |
| binding-view-stale-read | pass | A late binding read cannot reopen a deleted route. | 3 ms |
| binding-view-reassignment | pass | Old snapshots cannot repopulate a new partition owner. | 1 ms |
| binding-old-publication-revocation | pass | An old unsent open reference cannot hide a current PG revocation. | 1 ms |
| ordered-closure-open-fact | pass | Only the closed Kafka fact closes workflow orchestration; a newer PG revocation seen through an older fact is not a workflow command. | 1 ms |
| queue-view-snapshot-race | pass | Queue presentation never regresses after a newer committed change. | 52 ms |
| queue-view-read-isolation | pass | Disposable queue reads cannot hold ordered projection or another watched Session. | 54 ms |
| queue-view-reset-capacity | pass | Owner changes retain read-slot bounds and discard old completions; overflow requests resynchronization. | 51 ms |
| queue-wake-inflight | pass | A control change during reconciliation is not lost. | 5 ms |
| queue-known-retry | pass | Idle timers do not scan PG and known retries remain scheduled. | 1 ms |
| subagent-view-late-read | pass | A stale Subagent read cannot overwrite a newer family view. | 3 ms |
| subagent-pending-input-reference | pass | Evicting a body cannot discard durable unconsumed Agent input. | 1 ms |
| outbox-independent-send-and-cleanup | pass | One slow Session publication or cleanup cannot block other send slots, expired local claims are not duplicated, and cleanup drains multiple bounded batches. | 6842 ms |
| publication-readiness-assignment-replacement | pass | Old readiness replies cannot survive local ownership replacement; unready partitions remain queued. | 54 ms |
| publication-readiness-expiry | pass | A stalled readiness check cannot indefinitely authorize new Run admission. | 4 ms |
| control-change-concurrent-revision | pass | Transaction coalescing retains the post-lock revision so concurrent input invalidations cannot hide the final state. | 121 ms |
| subagent-noop-notification | pass | A conflicting no-op INSERT never publishes an imaginary source mutation. | 112 ms |
| control-coalescing-logical-restore | pass | Retained or logically restored references cannot collide with a new transaction; connection reuse and savepoint rollback clear temporary identity. | 65 ms |
| upload-owner-change-no-replay | pass | Ownership is resolved before byte consumption; a later redirect never implicitly replays a consumed upload stream. | 195 ms |
| worker-unlimited-memory-admission | pass | An unlimited cgroup cannot suppress all claims; real physical memory pressure and stale evidence still stop new-family admission. | 3 ms |
| upload-publication-parser-isolation | pass | Removing upload body limits cannot turn internal native publication frames into unparsed streams or remove their transport envelope. | 45 ms |
| streamed-s3-receipt-deadline | pass | A stalled receipt cannot renew upload claims indefinitely; progressing transfers retain their lifetime. | 281 ms |
| streamed-s3-body-abort | pass | Cancellation closes an S3 body even after HTTP headers have resolved. | 10 ms |
| projection-lane-read-scope | pass | Historical Lane count cannot amplify unrelated native append head reads. | 59 ms |
| presentation-pool-deadline | pass | Display queries have server deadlines and separate connection capacity from authority mutations. | 519 ms |
| verification-overlap | pass | A verification result cannot certify a mutation still running or completed after its start. | 1 ms |
| tool-cancel-acceptance-not-result | pass | A cancellation ACK cannot substitute for the original final Tool result. | 53 ms |
| tool-cancel-lost-publication-ack | pass | A received final reply wins even if cancellation publication ACK was lost. | 50 ms |
| tool-cancel-missing-final | pass | Missing cancellation results end within the grace and remain UNKNOWN, never invented stopping. | 22 ms |
| tool-cancel-completed-result | pass | A completed result is not retroactively cancelled. | 0 ms |
| tool-cancel-setsid-survival | pass | Normal Agent cancellation preserves independent setsid processes rather than killing the whole operation cgroup. | 63 ms |
| tool-cancel-completed-background | pass | Esc targets unfinished Tools, never background services left by completed calls. | 60 ms |
