# PiCloud deterministic fault evaluation

Generated: 2026-10-06T00:05:44.379Z

Revision: c2e920f91399a3bf94f9bb7938c95a043162856c

Uncommitted changes at test start: no

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 186
- File-group executions: 64; total wall time: 402613 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 186/186 (100.0%)
- p50 / p95: 58 ms / 6787 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| execution-probe-no-allocation | pass | Probes never allocate a VM; an expected missing binding is unavailable, not silently not-applicable. | 58 ms |
| execution-probe-fast-reply | pass | A fast complete return cannot be overwritten by a later admission receipt. | 104 ms |
| execution-probe-stale-identity | pass | Current scope, target and deadline are required for fresh evidence; unknown transport never authorizes resource recovery. | 53 ms |
| execution-probe-projector-reset | pass | Pending observations cannot survive Projector ownership reset as fresh acknowledgements. | 54 ms |
| runtime-probe-partial-inventory | pass | Partial inventory or failed guest responses cannot authorize VM destruction or quota release. | 1 ms |
| runtime-probe-fleet-coverage | pass | Every due physical runtime is examined without a 16-item truncation or unbounded concurrent requests. | 69 ms |
| execution-probe-independent-paths | pass | Missing guest replies do not block publication, native drain or future log-path probes; replaced bindings reject late evidence. | 13 ms |
| path-probe-stalled-ack | pass | At most one probe is outstanding per physical Session; a probe has no semantic commit to recover. | 3 ms |
| machine-rebind-release-race | pass | A pending machine release wins over a stale target lookup; rebinding checks a fresh snapshot after the machine lock. | 148 ms |
| machine-rebind-identity-and-retry | pass | Binding replay cannot duplicate or retarget the operation; native Session/model identity and previously accepted Run snapshots remain unchanged. | 325 ms |
| lease-sweep-independent-of-retirement | pass | A stalled remote stop cannot stall lease scanning; drain prevents another cleanup claim. | 36 ms |
| lease-sweep-pg-time | pass | Both initial expiry selection and final retirement use PG time, independent of API clock skew. | 4237 ms |
| path-probe-stale-replay | pass | A replay or stale probe cannot refresh liveness or create an active execution scope. | 7 ms |
| activity-writer-seal | pass | Tenant, partition and owner checks fence phase observations; a writer seal closes all sibling observations. | 5 ms |
| activity-terminal-sse | pass | Transient activity cannot alter transcript sequence or reopen a terminal turn. | 5 ms |
| upload-expiry-late-completion | pass | Expired drafts release image pins; a revoked upload cannot become a ready input after a late external reply. | 172 ms |
| upload-stream-gc-pin | pass | Streaming uploads exceed former product quotas while image reachability is pinned before final publication; GC cannot remove an active source. | 295 ms |
| upload-stream-digest-rejection | pass | A declared content digest is verified against the actual stream before ready metadata is published. | 29 ms |
| upload-symlink-confinement | pass | Upload placement cannot follow a substituted directory or destination link outside the authorized root. | 59 ms |
| upload-stream-truncation-cancel | pass | Truncated, overlong or cancelled transfers leave no partial published file, including above the former upload size limit. | 1045 ms |
| input-image-guest-cancel | pass | Input preparation is fenced independently of Agent Tool execution and remains tracked until guest cancellation finishes. | 31 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 3 ms |
| cancel-routing-publication-failure | pass | Agent cancellation revokes routing without stopping Cube processes; publication failure retains metadata and VM quota. | 52 ms |
| shared-runtime-loss | pass | A lost shared VM closes every binding and local admission even when closure publication is unavailable. | 4 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 53 ms |
| recovery-closure-pending | pass | Pending ordered closure neither quarantines a verified shared VM nor exposes partial local binding restoration. | 4 ms |
| allocation-preflight-not-absence | pass | Local preflight rejection cannot release an earlier uncertain same-ID allocation; closure and physical confirmation remain required. | 2 ms |
| projection-independent-cancel | pass | Cancelling a cold history waiter does not cancel the shared progress read or a sibling. | 54 ms |
| projection-owner-cache-fence | pass | Previously observed progress cannot authorize a retired owner or cache a failed read. | 25 ms |
| projection-lock-timeout-replay | pass | Server lock timeout leaves native history and projection positions unchanged; redelivery after release applies once. | 318 ms |
| projection-statement-timeout | pass | A timed-out SQL statement rolls back preceding writes and transaction-local timeout settings. | 131 ms |
| expired-owner-at-run-admission | pass | Final admission checks current PG time after locks; an expired lease cannot start the Agent or leave partial owner state. | 79 ms |
| cancel-native-projection-locks | pass | Cancellation lifecycle locks remain compatible with the native Record's Turn foreign key, so neither side deadlocks. | 229 ms |
| cancel-settlement-sql-abort | pass | A certified cancellation-settlement SQL abort retries only that transaction, never the external stop or Agent Loop. | 272 ms |
| ready-seal-atomicity | pass | A failed seal commit cannot release the next Lane task or decrement the family count; replay decrements once. | 146 ms |
| ready-input-before-seal | pass | Input acceptance and seal projection serialize on the Lane row and cannot leave a committed follow-up permanently waiting. | 280 ms |
| ready-seal-before-input | pass | Input waiting behind a seal transaction observes the committed closure and becomes ready without another notification. | 261 ms |
| first-record-commit-reply-loss | pass | A lost PG COMMIT reply preserves the first recovery floor and idempotent native projection. | 136 ms |
| first-record-rollback | pass | First native data and its recovery floor roll back together, and retry cannot skip the prefix. | 144 ms |
| projection-other-partition-progress | pass | A blocked delivery in one partition does not serialize unrelated partition handlers. | 52 ms |
| atomic-tool-replay | pass | Native intent projects before effect admission; replay never reissues the combined command. | 56 ms |
| atomic-tool-projection-failure | pass | Failed native projection cannot commit or dispatch its Tool command. | 2 ms |
| atomic-tool-commit-failure | pass | An unconfirmed Kafka dispatch commit cannot issue a Tool effect. | 1 ms |
| atomic-tool-rebalance | pass | Lost partition ownership after commit does not dispatch a new effect. | 1 ms |
| atomic-tool-seal | pass | An invocation after its scope seal cannot dispatch a Tool command. | 0 ms |
| projector-seal-replay | pass | Seal projection replay cannot duplicate a terminal or repeat execution closure; closure precedes publication. | 1 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 1 ms |
| worker-local-pending-capacity | pass | Local pending reservations bound overlapping claims without a PG slot counter; successors still wait for closure. | 627 ms |
| ready-family-owner-handoff | pass | A ready main Lane cannot acquire a new owner until the old sibling's final seal commits. | 8993 ms |
| cancel-pg-clock | pass | PG due time, claims and retries remain correct under application clock skew and concurrent dispatch. | 9946 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 37 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 9 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 2 ms |
| stale-accepted-fact-authority | pass | A record cannot install its own authority or bypass the PG-issued publication scope. | 1 ms |
| native-record-oversize-isolation | pass | Oversized individual publications fail before entering the bounded publication queue. | 5 ms |
| publication-seal-order | pass | Ingress closes old admission before draining and a successor cannot pass the ordered seal. | 111 ms |
| publication-stale-admission | pass | A delayed PG grant cannot reopen a scope after its closure completed. | 1 ms |
| publication-uncertain-queued-data | pass | Unknown semantic commit stops queued data while preserving ordered closure. | 1 ms |
| publication-lost-seal-ack | pass | PG canonical seal evidence releases a successor despite a lost producer ACK. | 1 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 5 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 306 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 389 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 80 ms |
| sandbox-control-owner-fence | pass | A replacement Sandbox control fences the expired owner before serving its Workspace runtime. | 5551 ms |
| quarantine-stale-physical-target | pass | A delayed old VM quarantine cannot rewrite its replacement identity or close replacement bindings. | 6875 ms |
| binding-view-owned-capacity | pass | Foreign partition payloads do not consume owner bootstrap row or byte budgets. | 6666 ms |
| agent-routing-retirement | pass | Routing retirement requires closure, isolates the exact Run even with a shared binding ID, and requires no Cube process receipt. | 5448 ms |
| controller-shutdown-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 5565 ms |
| controller-expiry-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 5582 ms |
| adoption-notification-outage | pass | Verified VM adoption and confirmed binding retirement survive notification outages through durable Outbox propagation. | 5651 ms |
| tool-cancel-retired-binding | pass | Durable cleanup intent survives Worker loss and routing-row retirement without a process-stop receipt table. | 5440 ms |
| allocation-intent-recovery | pass | Creation authorization and configuration survive controller loss; closure is irreversible and late completion cannot reopen the resource. | 7232 ms |
| allocation-unissued-closure | pass | Closing before authorization blocks later materialization without inferring physical absence from an inventory miss. | 6787 ms |
| allocation-legacy-uncertainty | pass | Historical missing allocation identity never becomes invented absence or quota release. | 6929 ms |
| controller-total-transaction-budget | pass | PG terminates overlong lifecycle transactions, frees ownership locks and retires the failed connection. | 8241 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 1 ms |
| quarantined-binding-late-command | pass | Durable routing closure rejects later Tool handoffs after dispatcher replacement without cancelling previously accepted processes. | 1 ms |
| tool-cancel-revoked-route | pass | Routing revocation blocks new work without blocking idempotent cancellation of an existing operation. | 3 ms |
| tool-cancel-unavailable-executor | pass | Executor communication failure never authorizes VM deletion or shell replay. | 1 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 3382 ms |
| tool-commit-before-effect | pass | A Tool command cannot dispatch until Kafka confirms its monotonic commit boundary. | 12 ms |
| tool-replay-without-effect | pass | Rebuilding volatile display state does not replay already committed Tool commands. | 13 ms |
| tool-native-late-result | pass | Completing guest work after closure cannot publish a usable native Tool result. | 7 ms |
| image-cleanup-composite-identity | pass | Image cleanup mutates only the tenant/object identities it locked, preserving another tenant's unexpired object. | 25 ms |
| image-upload-and-cleanup-failure | pass | Failed uploads cannot be retained; cleanup claims survive remote deletion failure. | 52 ms |
| image-unprojected-retention | pass | Kafka-acknowledged but unprojected images remain protected by their unsealed source Run. | 92 ms |
| image-cleanup-reference-race | pass | A deleting attachment cannot gain a canonical native reference. | 25 ms |
| image-cross-tenant-integrity | pass | A hash or tenant mismatch never becomes a successful native image. | 8 ms |
| image-native-fork-retention | pass | Cold reads and independent native Fork history retain the exact image bytes. | 235 ms |
| input-image-consumer-closure | pass | Consumer failure/early return never certifies an incomplete image and closes its source. | 13 ms |
| tool-reply-publication-failure | pass | Failed publication retires the pending image-adapter callback without crashing unrelated Worker families. | 8 ms |
| tool-reply-before-publication-ack | pass | Early reply rejection stays observed until command publication settles and never triggers an effect replay. | 5 ms |
| tool-reply-progress-rejected | pass | Observation-only progress cannot enter the final-result Kafka transport. | 2 ms |
| tool-reply-worker-loss | pass | A replacement Worker cannot attach an old operation's replies to a new Tool call. | 0 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 54 ms |
| gitlab-note-business-lock-release | pass | Provider HTTP holds no business transaction or row lock; one current note-sync claim does not block claim changes or ordinary Run admission. | 366 ms |
| gitlab-note-uncertain-create | pass | An uncertain remote create remains pending; marker readback recovers the applied note without repeating its creation in the tested lost-reply case. | 127 ms |
| gitlab-note-late-write | pass | Local claim fencing rejects a stale acknowledgement, and periodic remote verification repairs its late external write even after PG considered the latest version synced. | 166 ms |
| gitlab-note-ack-expiry | pass | Synchronization acknowledgement uses PG decision time after locking; a lease that expires while waiting cannot confirm remote output. | 581 ms |
| queued-edit-claim-race | pass | An admitted/locked Run cannot have its input rewritten by a pending edit. | 135 ms |
| queued-cancel-claim-race | pass | Pending cancellation cannot retire a Run whose admission already won. | 170 ms |
| queued-reorder-claim-race | pass | A locked queue neighbor cannot be reordered under an active admission. | 126 ms |
| queued-steer-lost-reply | pass | Canonical input consumption resolves a lost HTTP reply without executing the queued source. | 210 ms |
| queued-steer-seal-restore | pass | A missing reply alone cannot restore a queued source; an absent input plus projected seal can. | 249 ms |
| queued-steer-order | pass | Promotions to the same target preserve accepted delivery order across replicas. | 240 ms |
| queued-steer-shutdown | pass | Shutdown starts no further deliveries and restart finds the remaining durable controls. | 449 ms |
| queued-mutation-idempotency | pass | Concurrent API replicas cannot repeat a queue operation or silently overwrite a stale edit. | 83 ms |
| direct-steer-unconsumed-recovery | pass | A Worker acknowledgement never retires input; target closure restores unconsumed input without replaying its Run. | 374 ms |
| direct-steer-canonical-consumption | pass | Canonical input evidence wins over missing transport acknowledgement and prevents fallback execution. | 207 ms |
| direct-steer-late-reply | pass | A late Worker reply cannot overwrite a sealed-target restoration decision. | 176 ms |
| direct-steer-acceptance-race | pass | Direct Steer acceptance is atomic and idempotent under target locks and concurrent API replicas. | 161 ms |
| steer-acked-scope-recovery | pass | An HTTP ACK cannot retire pending native input; cold recovery and canonical wakes still reconcile it. | 1402 ms |
| queue-page-version | pass | Paging never mixes queue orders or limits the count of durable inputs. | 916 ms |
| queue-stop-steer-unconsumed | pass | An unconsumed Steer survives Stop as a paused input and cannot execute after service reconstruction. | 317 ms |
| queue-stop-steer-consumed | pass | Canonical consumption wins a Stop race; consumed input is not restored or executed again. | 317 ms |
| durable-return-stop-cut | pass | Repeated Stop returns the original unconsumed queue cut with uploads without withdrawing newly accepted messages. | 436 ms |
| durable-return-stop-pages | pass | All withdrawn pages preserve edited order and remain recoverable after lost acknowledgement. | 782 ms |
| durable-stop-steer-consumed | pass | Consumed Steer remains history and is not returned to the composer. | 317 ms |
| durable-stop-steer-unconsumed | pass | Unconsumed Steer returns only after ordered native closure proves nonconsumption. | 317 ms |
| workflow-result-budget | pass | A completed oversized workflow return becomes an explicit bounded error without repeating effects. | 57 ms |
| lease-batch-renewal-race | pass | An older lookup cannot revoke ownership confirmed by a newer committed renewal. | 1 ms |
| lease-batch-one-second-revocation | pass | Sharing heartbeat evidence does not slow periodic PG revocation observation. | 9 ms |
| lease-batch-no-revival | pass | Missing renewal retires the reported family while retaining other families; later replies cannot revive it. | 1 ms |
| lease-batch-read-failure | pass | A failed batch read fails closed for every owner in that observation. | 1 ms |
| lease-batch-incarnation | pass | Closing a lease observer prevents stale reads from affecting a later local incarnation. | 1 ms |
| indexed-log-quiescent-cutover | pass | An unsettled Session prevents schema cutover; settled cutover retains immutable bodies and never resurrects deleted Turn bindings. | 6558 ms |
| direct-steer-fk-locks | pass | Input acceptance does not deadlock with active Tool binding foreign-key checks. | 6665 ms |
| binding-view-stale-read | pass | A late binding read cannot reopen a deleted route. | 3 ms |
| binding-view-reassignment | pass | Old snapshots cannot repopulate a new partition owner. | 2 ms |
| binding-old-publication-revocation | pass | An old unsent open reference cannot hide a current PG revocation. | 1 ms |
| ordered-closure-open-fact | pass | Only the closed Kafka fact closes workflow orchestration; a newer PG revocation seen through an older fact is not a workflow command. | 1 ms |
| queue-view-snapshot-race | pass | Queue presentation never regresses after a newer committed change. | 52 ms |
| queue-view-read-isolation | pass | Disposable queue reads cannot hold ordered projection or another watched Session. | 56 ms |
| queue-view-reset-capacity | pass | Owner changes retain read-slot bounds and discard old completions; overflow requests resynchronization. | 52 ms |
| queue-wake-inflight | pass | A control change during reconciliation is not lost. | 7 ms |
| queue-known-retry | pass | Idle timers do not scan PG and known retries remain scheduled. | 1 ms |
| subagent-view-late-read | pass | A stale Subagent read cannot overwrite a newer family view. | 4 ms |
| subagent-pending-input-reference | pass | Evicting a body cannot discard durable unconsumed Agent input. | 2 ms |
| outbox-independent-send-and-cleanup | pass | One slow Session publication or cleanup cannot block other send slots, expired local claims are not duplicated, and cleanup drains multiple bounded batches. | 7628 ms |
| publication-readiness-assignment-replacement | pass | Old readiness replies cannot survive local ownership replacement; unready partitions remain queued. | 56 ms |
| publication-readiness-expiry | pass | A stalled readiness check cannot indefinitely authorize new Run admission. | 4 ms |
| control-change-concurrent-revision | pass | Transaction coalescing retains the post-lock revision so concurrent input invalidations cannot hide the final state. | 134 ms |
| subagent-noop-notification | pass | A conflicting no-op INSERT never publishes an imaginary source mutation. | 114 ms |
| control-coalescing-logical-restore | pass | Retained or logically restored references cannot collide with a new transaction; connection reuse and savepoint rollback clear temporary identity. | 75 ms |
| upload-owner-change-no-replay | pass | Ownership is resolved before byte consumption; a later redirect never implicitly replays a consumed upload stream. | 246 ms |
| worker-unlimited-memory-admission | pass | An unlimited cgroup cannot suppress all claims; real physical memory pressure and stale evidence still stop new-family admission. | 4 ms |
| upload-publication-parser-isolation | pass | Removing upload body limits cannot turn internal native publication frames into unparsed streams or remove their transport envelope. | 52 ms |
| streamed-s3-receipt-deadline | pass | A stalled receipt cannot renew upload claims indefinitely; progressing transfers retain their lifetime. | 283 ms |
| streamed-s3-body-abort | pass | Cancellation closes an S3 body even after HTTP headers have resolved. | 13 ms |
| presentation-pool-deadline | pass | Display queries have server deadlines and separate connection capacity from authority mutations. | 524 ms |
| verification-overlap | pass | A verification result cannot certify a mutation still running or completed after its start. | 2 ms |
| tool-cancel-setsid-survival | pass | Normal Agent cancellation preserves independent setsid processes rather than killing the whole operation cgroup. | 68 ms |
| tool-cancel-completed-background | pass | Esc targets unfinished Tools, never background services left by completed calls. | 65 ms |
| allocation-lost-create-reply | pass | Lost creation replies resolve by the original allocation, without allocating another VM. | 29 ms |
| allocation-late-create | pass | A delayed create cannot reopen a previously closed allocation. | 6 ms |
| controller-resource-renewal-isolation | pass | A blocked resource cannot revoke a healthy controller or block unrelated Workspace lifecycle work. | 8777 ms |
| controller-terminal-renewal-isolation | pass | Owner renewal does not depend on terminal resource-row maintenance. | 8776 ms |
| workflow-unknown-stops-sampling | pass | Unknown Workflow effects prevent a second model request without shell replay. | 12 ms |
| workflow-socket-loss-stops-sampling | pass | An unconfirmed Workflow connection close is a typed infrastructure failure. | 11 ms |
| workflow-business-error-continues | pass | Ordinary script errors cannot be mistaken for infrastructure loss by their text. | 39 ms |
| started-cancel-outcome-unknown | pass | Interruption after native execution may have effects; only explicit before-start cancellation proves no execution. | 0 ms |
| durable-ack-visibility | pass | Projection visibility cannot turn an unacknowledged publication into adopted native state; ambiguous ownership refuses further commits. | 95 ms |
| durable-proved-refusal | pass | Certified pre-enqueue refusal preserves sequence; conflicting duplicate bodies cannot change native state. | 32 ms |
| durable-document-tail | pass | Derived document checkpoints bound cold reconstruction without changing native history or delta counts. | 1119 ms |
| durable-paused-projection | pass | ACKed progress remains available through PG lag and cold reads remain scoped to the requested suffix. | 929 ms |
| durable-no-hot-sql | pass | Ordinary warm native commits do not add per-Step PG receipts. | 167 ms |
| durable-native-image-locations | pass | Native images remain immutable references across new record and document locations and cold decoding. | 422 ms |
| durable-origin-recovery | pass | A cleanup owner cannot reassign the original task/result provenance. | 32 ms |
| durable-budget-floor | pass | Recovery cannot refill finite Run budgets; abort-mark duplicates do not consume another native intent. | 49 ms |
| durable-shared-host | pass | One physical writer serves sibling Conversations and preserves acknowledged native state during scoped close and cold restore. | 419 ms |
| durable-display-coverage | pass | Display coverage requires its committed native sequence and cannot mutate an existing snapshot. | 140 ms |
| durable-projection-replay | pass | Native projection redelivery preserves one exact canonical commit. | 103 ms |
| durable-post-seal-refusal | pass | A sealed writer cannot append late native state. | 144 ms |
| durable-unsafe-recovery | pass | Native recovery never replays unsafe Tool effects and cannot request a model before PG-authorized binding. | 39 ms |
| durable-native-cancel | pass | Ordered physical cancellation accompanies native abort; late physical results never overwrite that settlement. | 8 ms |
| durable-validated-intent | pass | One native execute checkpoint authorizes the exact validated remote arguments without persisting model credentials. | 28 ms |
| durable-invalid-arguments | pass | Native validation failure does not prepare or dispatch external effects. | 9 ms |
| durable-child-generation-reply | pass | The native generation owns delegated Conversations: returning a blocked Tool permits a parent reply, while parent abort still cancels child work. | 16 ms |
| durable-child-generation-abort | pass | The native generation owns delegated Conversations: returning a blocked Tool permits a parent reply, while parent abort still cancels child work. | 10 ms |
| durable-same-run-recovery | pass | Replacement retains logical Run/Turn identity, waits for old closure and rejects stale owner callbacks. | 227 ms |
| durable-stop-before-recovery-seal | pass | A Stop racing old-owner closure is preserved for the replacement owner without consuming the queued input. | 180 ms |
| durable-stop-after-recovery-seal | pass | A Stop after recovery closure cannot be lost between queued and admitted native ownership. | 174 ms |
| durable-model-slot-release | pass | A remote Tool wait does not hold a model permit or create a second handoff. | 74 ms |
| durable-verification-recovery | pass | Verification is derived from native history at yield and its continuation cannot duplicate after recovery. | 33 ms |
| durable-fork-documents | pass | Independent forks honor native document cutoff/current semantics without copying execution grants. | 205 ms |
| durable-active-tool-query | pass | Plain conversation reads show the committed native Tool execute checkpoint without waiting for its final result or creating another Tool ledger. | 145 ms |
