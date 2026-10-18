# PiCloud deterministic fault evaluation

Generated: 2026-10-18T09:53:56.591Z

Revision: 079dbddc7c3c523de68c276adf7a7bb8d803fef6

Uncommitted changes at test start: no

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 302
- File-group executions: 92; total wall time: 516596 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 302/302 (100.0%)
- p50 / p95: 55 ms / 6036 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| guest-deleted-working-directory | pass | A confirmed missing user directory returns a native Tool error without command effects or implicit directory repair; explicit restoration permits new work. | 991 ms |
| guest-working-directory-replaced-by-file | pass | Non-directory paths fail before Tool execution without changing existing bytes or choosing another cwd. | 928 ms |
| guest-working-directory-unexpected-failure | pass | Only known missing-path failures are ordinary results; other filesystem preparation failures retain infrastructure classification. | 471 ms |
| guest-running-command-directory-deletion | pass | Directory deletion does not retroactively cancel a running command or permit a later command to start in a missing cwd. | 2952 ms |
| completion-directory-native-error | pass | Completion retains the original native Tool error and callback identity rather than manufacturing an UNKNOWN transport failure. | 1 ms |
| completion-attachment-remains-unknown | pass | Workspace attachment failure is not downgraded into an ordinary directory error. | 1 ms |
| completion-guest-failure-remains-unknown | pass | An unexpected guest execution failure retains uncertain effects and the existing sampling guard. | 0 ms |
| started-cancel-outcome-unknown | pass | Interruption after native execution may have effects; only explicit before-start cancellation proves no execution. | 0 ms |
| guest-malformed-result-shape | pass | A malformed guest final content shape is returned as an explicit protocol failure before image handling. | 6 ms |
| native-harness-directory-error-continuation | pass | Pi Harness persists the directory Tool error and makes the next model request without marking the executor unavailable. | 10 ms |
| tool-reply-publication-failure | pass | Failed publication retires the pending image-adapter callback without crashing unrelated Worker families. | 1 ms |
| tool-reply-before-publication-ack | pass | Early reply rejection stays observed until command publication settles and never triggers an effect replay. | 1 ms |
| native-read-harness-diagnostics | pass | The canonical Tool result and model context retain continuation guidance after native content bounding. | 9 ms |
| unknown-native-inspection | pass | A validated fresh path permits native inspection after committed UNKNOWN without replaying the original effect or exposing probes to context. | 44 ms |
| unknown-repeated-failure | pass | A small successful probe cannot cause endless model sampling when actual Tool replies remain unavailable. | 12 ms |
| unknown-stop-during-readiness | pass | User cancellation takes precedence over a concurrent successful readiness check. | 52 ms |
| unknown-protocol-failure | pass | A malformed final reply retains interruption instead of being downgraded to a lost reply. | 8 ms |
| input-admission-wait-retry | pass | A waiting replica reads the committed idempotency record after acquiring the Session lock and returns the same Run. | 155 ms |
| input-admission-wait-conflict | pass | A waiting request with changed content cannot reuse an input key or allocate another Run. | 128 ms |
| input-admission-model-first | pass | Input waiting for a model change freezes the newly committed Session selection. | 64 ms |
| input-admission-input-first | pass | A model change waiting behind admission cannot change the model of an accepted queued Run. | 103 ms |
| input-admission-rollback-lifetime | pass | Rollback removes Run and mailbox advancement; escaped actions cannot reuse ended transaction authority. | 57 ms |
| input-admission-workspace-deletion | pass | Reusing the Session read does not bypass a subsequent Workspace availability check. | 33 ms |
| input-admission-tenant-scope | pass | The reused admission scope cannot create or deliver an input for a mismatched tenant. | 28 ms |
| native-input-unavailable | pass | Unconfirmed delivery leaves one cloud execution and no second durable payload queue. | 348 ms |
| native-input-lost-confirmation | pass | A lost native ACK or edit response cannot duplicate input or restore obsolete text; cold history includes consumed human content. | 482 ms |
| native-input-stale-edit | pass | Native queue edits and consumption share one commit line; intervening reorder prevents stale overwrite. | 380 ms |
| native-input-page-revision | pass | Only pending input changes invalidate an edit/pagination revision. | 1187 ms |
| native-input-stop-seal | pass | Stop restores unconsumed input after closure and rejects premature acknowledgement. | 533 ms |
| native-input-consumed-stop | pass | Consumed native submissions cannot be restored as unsent drafts. | 385 ms |
| native-input-return-pages | pass | One browser acknowledging a returned batch cannot truncate another browser restoring its pages. | 1243 ms |
| initial-input-edit-claim | pass | An initial-input mutation conflicts with a Worker claim instead of deadlocking or changing admitted input. | 60 ms |
| initial-input-cancel-claim | pass | An initial-input mutation conflicts with a Worker claim instead of deadlocking or changing admitted input. | 57 ms |
| initial-input-move-claim | pass | An initial-input mutation conflicts with a Worker claim instead of deadlocking or changing admitted input. | 58 ms |
| projection-replay-stable-tuples | pass | Replayed coverage and partition progress preserve tuple versions, native bytes, monotonic cursors and the first recovery floor. | 259 ms |
| projection-display-missing-native | pass | A no-op coverage replay still requires the referenced canonical native commit. | 144 ms |
| projection-run-cutoff-wait | pass | Native projection locks the Run before the shared writer and rechecks the Run cutoff after waiting. | 112 ms |
| projection-writer-cutoff-wait | pass | Native projection rechecks a concurrently committed writer cutoff before writing history or advancing recovery progress. | 157 ms |
| projection-display-concurrent-advance | pass | A waiting coverage statement sees the current locked Run and neither regresses nor rewrites a newer cursor. | 161 ms |
| projection-lock-timeout-replay | pass | Server lock timeout leaves native history and projection positions unchanged; redelivery after release applies once. | 199 ms |
| projection-statement-timeout | pass | A timed-out SQL statement rolls back preceding writes and transaction-local timeout settings. | 135 ms |
| expired-owner-at-run-admission | pass | Final admission checks current PG time after locks; an expired lease cannot start the Agent or leave partial owner state. | 77 ms |
| cancel-native-projection-locks | pass | A failed completion projection is retried without repeating native cancellation. | 169 ms |
| cancel-during-writer-bootstrap | pass | Stop survives authorized writer bootstrap, blocks model/Tool effects and settles once through native cancellation. | 191 ms |
| cancel-during-recovered-writer-bootstrap | pass | A genuine writer startup failure closes in order; its recovered owner settles the pending Stop without repeated requeueing. | 279 ms |
| cancel-bootstrap-ack-rollback | pass | A rolled-back Stop acknowledgement cannot start model/Tool work or strand a runner waiting for a cancellation signal. | 136 ms |
| cancel-settlement-sql-abort | pass | A transaction rollback during final cancellation projection cannot repeat the Agent abort or native effects. | 187 ms |
| ready-seal-atomicity | pass | A failed seal commit cannot release the next Lane task or decrement the family count; replay decrements once. | 157 ms |
| ready-input-before-seal | pass | Input acceptance and seal projection serialize on the Lane row and cannot leave a committed follow-up permanently waiting. | 195 ms |
| ready-seal-before-input | pass | Input waiting behind a seal transaction observes the committed closure and becomes ready without another notification. | 201 ms |
| first-record-commit-reply-loss | pass | A lost PG COMMIT reply preserves the first recovery floor and idempotent native projection. | 115 ms |
| first-record-rollback | pass | First native data and its recovery floor roll back together, and retry cannot skip the prefix. | 116 ms |
| session-producer-waiting-recovery | pass | Existing Worker heartbeat checks recover a failed producer even while its model has no new commit. | 127 ms |
| durable-tool-draft-publication | pass | Streaming Tool drafts never enter native commits; complete calls execute only after their validated intent is acknowledged. | 230 ms |
| durable-tool-draft-provider-mutation | pass | Provider mutation cannot insert Tool arguments into an earlier partial already delivered to Durable. | 205 ms |
| durable-tool-draft-stop | pass | Stopping an incomplete call retains committed text without persisting arguments, executing the Tool or inventing a result. | 154 ms |
| durable-tool-draft-recovery | pass | Recovery resumes the original input without replaying or retaining an incomplete Tool call. | 156 ms |
| execution-probe-no-allocation | pass | Probes never allocate a VM; an expected missing binding is unavailable, not silently not-applicable. | 51 ms |
| execution-probe-fast-reply | pass | A fast complete return cannot be overwritten by a later admission receipt. | 103 ms |
| execution-probe-stale-identity | pass | Current scope, target and deadline are required for fresh evidence; unknown transport never authorizes resource recovery. | 52 ms |
| execution-probe-projector-reset | pass | Pending observations cannot survive Projector ownership reset as fresh acknowledgements. | 52 ms |
| readiness-current-binding | pass | Closed/replaced bindings and expired or mismatched probe evidence cannot confirm readiness. | 55 ms |
| readiness-owner-replacement | pass | Projector replacement invalidates an outstanding readiness confirmation. | 51 ms |
| runtime-probe-partial-inventory | pass | Partial inventory or failed guest responses cannot authorize VM destruction or quota release. | 1 ms |
| runtime-probe-fleet-coverage | pass | Every due physical runtime is examined without a 16-item truncation or unbounded concurrent requests. | 61 ms |
| execution-probe-independent-paths | pass | Missing guest replies do not block publication, native drain or future log-path probes; replaced bindings reject late evidence. | 2 ms |
| path-probe-stalled-ack | pass | At most one probe is outstanding per physical Session; a probe has no semantic commit to recover. | 2 ms |
| readiness-lost-reply | pass | A missing guest reply ends the fault check within its budget without authorizing continuation. | 6 ms |
| readiness-lost-publication-ack | pass | An unconfirmed probe publication cannot pin a readiness waiter or be treated as successful evidence. | 1 ms |
| machine-rebind-release-race | pass | A pending machine release wins over a stale target lookup; rebinding checks a fresh snapshot after the machine lock. | 116 ms |
| machine-rebind-identity-and-retry | pass | Binding replay cannot duplicate or retarget the operation; native Session/model identity and previously accepted Run snapshots remain unchanged. | 190 ms |
| lease-sweep-independent-of-retirement | pass | A stalled remote stop cannot stall lease scanning; drain prevents another cleanup claim. | 33 ms |
| lease-sweep-pg-time | pass | Both initial expiry selection and final retirement use PG time, independent of API clock skew. | 3825 ms |
| path-probe-stale-replay | pass | A replay or stale probe cannot refresh liveness or create an active execution scope. | 5 ms |
| activity-writer-seal | pass | Tenant, partition and owner checks fence phase observations; a writer seal closes all sibling observations. | 5 ms |
| browser-observation-cache-expiry | pass | Nonterminal observation eviction cannot silently reset counters beneath an existing reader. | 1 ms |
| activity-terminal-sse | pass | Transient activity cannot alter transcript sequence or reopen a terminal turn. | 7 ms |
| upload-expiry-late-completion | pass | Expired drafts release image pins; a revoked upload cannot become a ready input after a late external reply. | 171 ms |
| upload-stream-gc-pin | pass | Streaming uploads exceed former product quotas while image reachability is pinned before final publication; GC cannot remove an active source. | 314 ms |
| upload-stream-digest-rejection | pass | A declared content digest is verified against the actual stream before ready metadata is published. | 32 ms |
| upload-symlink-confinement | pass | Upload placement cannot follow a substituted directory or destination link outside the authorized root. | 50 ms |
| upload-stream-truncation-cancel | pass | Truncated, overlong or cancelled transfers leave no partial published file, including above the former upload size limit. | 975 ms |
| input-image-guest-cancel | pass | Input preparation is fenced independently of Agent Tool execution and remains tracked until guest cancellation finishes. | 31 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 3 ms |
| cancel-routing-publication-failure | pass | Agent cancellation revokes routing without stopping Cube processes; publication failure retains metadata and VM quota. | 1 ms |
| shared-runtime-loss | pass | A lost shared VM closes every binding and local admission even when closure publication is unavailable. | 3 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 52 ms |
| recovery-closure-pending | pass | Pending ordered closure neither quarantines a verified shared VM nor exposes partial local binding restoration. | 4 ms |
| allocation-preflight-not-absence | pass | Local preflight rejection cannot release an earlier uncertain same-ID allocation; closure and physical confirmation remain required. | 2 ms |
| projection-independent-cancel | pass | Cancelling a cold history waiter does not cancel the shared progress read or a sibling. | 53 ms |
| projection-owner-cache-fence | pass | Previously observed progress cannot authorize a retired owner or cache a failed read. | 25 ms |
| projection-other-partition-progress | pass | A blocked delivery in one partition does not serialize unrelated partition handlers. | 52 ms |
| atomic-tool-replay | pass | Native intent projects before effect admission; replay never reissues the combined command. | 58 ms |
| atomic-tool-projection-failure | pass | Failed native projection cannot commit or dispatch its Tool command. | 2 ms |
| atomic-tool-commit-failure | pass | An unconfirmed Kafka dispatch commit cannot issue a Tool effect. | 1 ms |
| atomic-tool-rebalance | pass | Lost partition ownership after commit does not dispatch a new effect. | 0 ms |
| atomic-tool-seal | pass | An invocation after its scope seal cannot dispatch a Tool command. | 1 ms |
| projector-seal-replay | pass | Seal projection replay cannot duplicate a terminal or repeat execution closure; closure precedes publication. | 1 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 1 ms |
| worker-local-pending-capacity | pass | Local pending reservations bound overlapping claims without a PG slot counter; successors still wait for closure. | 547 ms |
| cancel-before-native-setup | pass | An already signalled Stop passes immutable Workspace metadata preparation and settles in native Pi without acquiring a model permit or activating Cube. | 29 ms |
| ready-family-owner-handoff | pass | One physical Session admits only one root work until its previous writer is closed, across Worker contenders. | 6139 ms |
| cancel-pg-clock | pass | PG due time, claims and retries remain correct under application clock skew and concurrent dispatch. | 6096 ms |
| quarantine-exit-first | pass | Missing or stale execution exit/seal proof never authorizes recovery, independently of native input consumption. | 6265 ms |
| quarantine-seal-first | pass | Missing or stale execution exit/seal proof never authorizes recovery, independently of native input consumption. | 6336 ms |
| quarantine-no-exit-proof | pass | Missing or stale execution exit/seal proof never authorizes recovery, independently of native input consumption. | 6319 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 24 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 5 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 2 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 4 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 167 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 352 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 50 ms |
| sandbox-control-owner-fence | pass | A replacement Sandbox control fences the expired owner before serving its Workspace runtime. | 5824 ms |
| quarantine-stale-physical-target | pass | A delayed old VM quarantine cannot rewrite its replacement identity or close replacement bindings. | 5951 ms |
| binding-view-owned-capacity | pass | Foreign partition payloads do not consume owner bootstrap row or byte budgets. | 6130 ms |
| agent-routing-retirement | pass | Routing retirement requires closure, isolates the exact Run even with a shared binding ID, and requires no Cube process receipt. | 5950 ms |
| controller-shutdown-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 6005 ms |
| controller-expiry-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 5904 ms |
| adoption-notification-outage | pass | Verified VM adoption and confirmed binding retirement survive notification outages through durable Outbox propagation. | 5923 ms |
| tool-cancel-retired-binding | pass | Durable cleanup intent survives Worker loss and routing-row retirement without a process-stop receipt table. | 5891 ms |
| allocation-intent-recovery | pass | Creation authorization and configuration survive controller loss; closure is irreversible and late completion cannot reopen the resource. | 6016 ms |
| allocation-unissued-closure | pass | Closing before authorization blocks later materialization without inferring physical absence from an inventory miss. | 5966 ms |
| allocation-legacy-uncertainty | pass | Historical missing allocation identity never becomes invented absence or quota release. | 5884 ms |
| controller-total-transaction-budget | pass | PG terminates overlong lifecycle transactions, frees ownership locks and retires the failed connection. | 6654 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 1 ms |
| quarantined-binding-late-command | pass | Durable routing closure rejects later Tool handoffs after dispatcher replacement without cancelling previously accepted processes. | 1 ms |
| tool-cancel-revoked-route | pass | Routing revocation blocks new work without blocking idempotent cancellation of an existing operation. | 3 ms |
| tool-cancel-unavailable-executor | pass | Executor communication failure never authorizes VM deletion or shell replay. | 1 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 3701 ms |
| tool-commit-before-effect | pass | A Tool command cannot dispatch until Kafka confirms its monotonic commit boundary. | 10 ms |
| tool-replay-without-effect | pass | Rebuilding volatile display state does not replay already committed Tool commands. | 11 ms |
| partition-progress-isolation | pass | One pending partition cannot hold periodic progress of another partition across ticks. | 2000 ms |
| reply-volatile-reconnect | pass | Reassignment keeps completed delivery progress in the same boot without a durable second cursor. | 266 ms |
| reply-inflight-reassignment | pass | Reassignment joins old callbacks and does not skip unfinished or stale handling. | 11 ms |
| reply-inconsistent-position | pass | An impossible local position remains unhealthy across reassignment instead of silently rewinding. | 11 ms |
| tool-native-late-result | pass | Completing guest work after closure cannot publish a usable native Tool result. | 7 ms |
| image-cleanup-composite-identity | pass | Image cleanup mutates only the tenant/object identities it locked, preserving another tenant's unexpired object. | 24 ms |
| image-upload-and-cleanup-failure | pass | Failed uploads cannot be retained; cleanup claims survive remote deletion failure. | 60 ms |
| image-unprojected-retention | pass | Kafka-acknowledged but unprojected images remain protected by their unsealed source Run. | 94 ms |
| image-cleanup-reference-race | pass | A deleting attachment cannot gain a canonical native reference. | 24 ms |
| image-cross-tenant-integrity | pass | A hash or tenant mismatch never becomes a successful native image. | 10 ms |
| image-native-fork-retention | pass | Cold reads and independent native Fork history retain the exact image bytes. | 269 ms |
| input-image-consumer-closure | pass | Consumer failure/early return never certifies an incomplete image and closes its source. | 12 ms |
| tool-reply-progress-rejected | pass | Observation-only progress cannot enter the final-result Kafka transport. | 3 ms |
| tool-reply-worker-loss | pass | A replacement Worker cannot attach an old operation's replies to a new Tool call. | 1 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 53 ms |
| gitlab-note-business-lock-release | pass | Provider HTTP holds no business transaction or row lock; one current note-sync claim does not block claim changes or ordinary Run admission. | 275 ms |
| gitlab-note-uncertain-create | pass | An uncertain remote create remains pending; marker readback recovers the applied note without repeating its creation in the tested lost-reply case. | 112 ms |
| gitlab-note-late-write | pass | Local claim fencing rejects a stale acknowledgement, and periodic remote verification repairs its late external write even after PG considered the latest version synced. | 152 ms |
| gitlab-note-ack-expiry | pass | Synchronization acknowledgement uses PG decision time after locking; a lease that expires while waiting cannot confirm remote output. | 564 ms |
| workflow-result-budget | pass | A completed oversized workflow return becomes an explicit bounded error without repeating effects. | 40 ms |
| workflow-native-line-overflow | pass | Guest and trusted receiver preserve completed effects while rejecting output beyond native line bounds. | 27 ms |
| lease-batch-renewal-race | pass | An older lookup cannot revoke ownership confirmed by a newer committed renewal. | 0 ms |
| lease-batch-one-second-revocation | pass | Sharing heartbeat evidence does not slow periodic PG revocation observation. | 8 ms |
| lease-batch-no-revival | pass | Missing renewal retires the reported family while retaining other families; later replies cannot revive it. | 1 ms |
| lease-batch-read-failure | pass | A failed batch read fails closed for every owner in that observation. | 1 ms |
| lease-batch-incarnation | pass | Closing a lease observer prevents stale reads from affecting a later local incarnation. | 1 ms |
| lease-pending-observer-deadline | pass | No pending PG read suppresses the last confirmed active-owner deadline; late responses cannot revive it. | 1 ms |
| lease-event-loop-expiry | pass | An overdue active owner fails its next local authority check even before timers run. | 0 ms |
| lease-deferred-not-renewed | pass | A busy-row deferral neither grants time nor falsely revokes an eligible owner. | 1 ms |
| indexed-log-quiescent-cutover | pass | An unsettled Session prevents schema cutover; settled cutover retains immutable bodies and never resurrects deleted Turn bindings. | 5735 ms |
| direct-steer-fk-locks | pass | Native input RPC holds no cloud admission transaction; concurrent foreign-key references do not deadlock intake. | 6102 ms |
| binding-view-stale-read | pass | A late binding read cannot reopen a deleted route. | 2 ms |
| binding-view-reassignment | pass | Old snapshots cannot repopulate a new partition owner. | 1 ms |
| binding-old-publication-revocation | pass | An old unsent open reference cannot hide a current PG revocation. | 0 ms |
| ordered-closure-open-fact | pass | Only the closed Kafka fact closes workflow orchestration; a newer PG revocation seen through an older fact is not a workflow command. | 1 ms |
| queue-view-snapshot-race | pass | Queue presentation never regresses after a newer committed change. | 52 ms |
| queue-view-read-isolation | pass | Disposable queue reads cannot hold ordered projection or another watched Session. | 54 ms |
| queue-view-reset-capacity | pass | Owner changes retain read-slot bounds and discard old completions; overflow requests resynchronization. | 51 ms |
| subagent-view-late-read | pass | A stale Subagent read cannot overwrite a newer family view. | 3 ms |
| subagent-pending-input-reference | pass | Rebuilding control references cannot revive a settled native effect. | 1648 ms |
| subagent-noop-notification | pass | An old control handler cannot publish after its partition ownership is replaced. | 1366 ms |
| outbox-independent-send-and-cleanup | pass | One slow Session publication or cleanup cannot block other send slots, expired local claims are not duplicated, and cleanup drains multiple bounded batches. | 8667 ms |
| publication-readiness-assignment-replacement | pass | Old readiness replies cannot survive local ownership replacement; unready partitions remain queued. | 55 ms |
| publication-readiness-expiry | pass | A stalled readiness check cannot indefinitely authorize new Run admission. | 3 ms |
| control-change-concurrent-revision | pass | Transaction coalescing retains the post-lock revision so concurrent input invalidations cannot hide the final state. | 115 ms |
| control-coalescing-logical-restore | pass | Retained or logically restored references cannot collide with a new transaction; connection reuse and savepoint rollback clear temporary identity. | 90 ms |
| upload-owner-change-no-replay | pass | Ownership is resolved before byte consumption; a later redirect never implicitly replays a consumed upload stream. | 203 ms |
| worker-unlimited-memory-admission | pass | An unlimited cgroup cannot suppress all claims; real physical memory pressure and stale evidence still stop new-family admission. | 3 ms |
| upload-publication-parser-isolation | pass | Removing upload body limits cannot turn internal native publication frames into unparsed streams or remove their transport envelope. | 40 ms |
| streamed-s3-receipt-deadline | pass | A stalled receipt cannot renew upload claims indefinitely; progressing transfers retain their lifetime. | 283 ms |
| streamed-s3-body-abort | pass | Cancellation closes an S3 body even after HTTP headers have resolved. | 10 ms |
| presentation-pool-deadline | pass | Display queries have server deadlines and separate connection capacity from authority mutations. | 520 ms |
| verification-overlap | pass | A verification result cannot certify a mutation still running or completed after its start. | 1 ms |
| tool-cancel-setsid-survival | pass | Normal Agent cancellation preserves independent setsid processes rather than killing the whole operation cgroup. | 64 ms |
| tool-cancel-completed-background | pass | Esc targets unfinished Tools, never background services left by completed calls. | 61 ms |
| native-read-long-multibyte-line | pass | Bounded Read retains a UTF-8-safe file prefix and native byte continuation diagnostics. | 26 ms |
| allocation-lost-create-reply | pass | Lost creation replies resolve by the original allocation, without allocating another VM. | 25 ms |
| allocation-late-create | pass | A delayed create cannot reopen a previously closed allocation. | 5 ms |
| controller-resource-renewal-isolation | pass | A blocked resource cannot revoke a healthy controller or block unrelated Workspace lifecycle work. | 8271 ms |
| controller-terminal-renewal-isolation | pass | Owner renewal does not depend on terminal resource-row maintenance. | 8072 ms |
| workflow-unknown-stops-sampling | pass | Unknown Workflow effects prevent a second model request without shell replay. | 13 ms |
| workflow-socket-loss-stops-sampling | pass | An unconfirmed Workflow connection close is a typed infrastructure failure. | 11 ms |
| workflow-business-error-continues | pass | Ordinary script errors cannot be mistaken for infrastructure loss by their text. | 41 ms |
| durable-ack-visibility | pass | Projection visibility cannot turn an unacknowledged publication into adopted native state; ambiguous ownership refuses further commits. | 62 ms |
| durable-proved-refusal | pass | Certified pre-enqueue refusal preserves sequence; conflicting duplicate bodies cannot change native state. | 30 ms |
| durable-document-tail | pass | Derived document checkpoints bound cold reconstruction without changing native history or delta counts. | 1154 ms |
| durable-paused-projection | pass | ACKed progress remains available through PG lag and cold reads remain scoped to the requested suffix. | 146 ms |
| durable-no-hot-sql | pass | Ordinary warm native commits do not add per-Step PG receipts. | 138 ms |
| durable-native-image-locations | pass | Native images remain immutable references across new record and document locations and cold decoding. | 408 ms |
| durable-origin-recovery | pass | A cleanup owner cannot reassign the original task/result provenance. | 36 ms |
| durable-budget-floor | pass | Recovery cannot refill finite Run budgets; abort-mark duplicates do not consume another native intent. | 49 ms |
| durable-complete-document-overlay | pass | Complete acknowledged documents need no projection revision query; incomplete and historical overlays retain PG reconstruction. | 1091 ms |
| native-live-stream-retention | pass | Streaming payloads stay in Kafka while acknowledged native current reads survive ordinary PG-buffer flushes. | 946 ms |
| native-live-replay-handoff | pass | Replay detects gaps and changed bytes; a handoff preserves exact native state without allocating a native sequence. | 150 ms |
| native-live-rollback | pass | SQL rollback advances neither authoritative recovery references nor adopted Projector memory. | 42 ms |
| native-live-lost-ack | pass | Lost acknowledgement poisons the old writer but does not discard an accepted partial during native recovery. | 57 ms |
| native-live-interleaving | pass | One Conversation settling never discards another Conversation's in-flight state in the same physical Session. | 97 ms |
| durable-shared-host | pass | One physical Session shares one root grant and native writer across child views and cold recovery. | 366 ms |
| durable-display-coverage | pass | Display coverage requires its committed native sequence and cannot mutate an existing snapshot. | 111 ms |
| durable-projection-replay | pass | Native projection redelivery preserves one exact canonical commit. | 112 ms |
| durable-post-seal-refusal | pass | Ordered Session closure prevents late native state from becoming canonical. | 174 ms |
| native-live-seal-gate | pass | Writer closure waits for complete live reconstruction and commits its exact checkpoint before replacement. | 211 ms |
| durable-unsafe-recovery | pass | Native recovery never replays unsafe Tool effects and cannot request a model before PG-authorized binding. | 39 ms |
| durable-native-cancel | pass | Ordered physical cancellation accompanies native abort; late physical results never overwrite that settlement. | 6 ms |
| durable-validated-intent | pass | One native execute checkpoint authorizes the exact validated remote arguments without persisting model credentials. | 28 ms |
| durable-invalid-arguments | pass | Native validation failure does not prepare or dispatch external effects. | 8 ms |
| durable-child-generation-reply | pass | The native generation owns delegated Conversations: returning a blocked Tool permits a parent reply, while parent abort still cancels child work. | 18 ms |
| durable-child-generation-abort | pass | The native generation owns delegated Conversations: returning a blocked Tool permits a parent reply, while parent abort still cancels child work. | 11 ms |
| durable-same-run-recovery | pass | Replacement retains logical Run/Turn identity, waits for old closure and rejects stale owner callbacks. | 310 ms |
| durable-stop-before-recovery-seal | pass | A Stop racing old-owner closure is preserved for the replacement owner without consuming the queued input. | 242 ms |
| durable-stop-after-recovery-seal | pass | A Stop after recovery closure cannot be lost between queued and admitted native ownership. | 219 ms |
| durable-model-slot-release | pass | A remote Tool wait does not hold a model permit or create a second handoff. | 87 ms |
| durable-verification-recovery | pass | Verification is derived from native history at yield and its continuation cannot duplicate after recovery. | 36 ms |
| durable-fork-documents | pass | Independent forks honor native document cutoff/current semantics without copying execution grants. | 206 ms |
| durable-active-tool-query | pass | Plain conversation reads show the committed native Tool execute checkpoint without waiting for its final result or creating another Tool ledger. | 100 ms |
| native-tree-bounded-prefix-copy | pass | Navigation omits unrelated Tool payloads while an independent Fork preserves the full selected native prefix. | 416 ms |
| native-index-text-backfill | pass | Index backfill/rebuild leaves canonical JSON text exact and refuses outdated metadata writes. | 181 ms |
| durable-active-tool-uncovered | pass | A durable executing Tool can be queried before display coverage without replaying uncovered assistant text. | 89 ms |
| durable-compaction-reopen-summarize | pass | Recovered native Compaction uses its committed Task identity only after a fresh cloud grant; Stop cannot dispatch a held model request. | 25 ms |
| durable-compaction-reopen-retry | pass | Recovered native Compaction uses its committed Task identity only after a fresh cloud grant; Stop cannot dispatch a held model request. | 9 ms |
| durable-compaction-reopen-stop | pass | Recovered native Compaction uses its committed Task identity only after a fresh cloud grant; Stop cannot dispatch a held model request. | 5 ms |
| durable-terminal-snapshot-identity | pass | Dropped start events cannot lose or shift sampling completion identity. | 1 ms |
| durable-recovered-partial-identity | pass | An old interrupted partial cannot consume the replacement request identity. | 0 ms |
| durable-retry-before-final | pass | Retry progress belongs to the request whose native terminal has not been displayed yet. | 0 ms |
| volume-lock-holder-killed | pass | A live filesystem callback owns exclusion independently of the acquisition utility; process death releases its descriptor. | 330 ms |
| volume-lock-pg-loss | pass | PG connection loss cannot let a new filesystem callback overlap the old holder. | 78 ms |
| volume-lock-replaced-inode | pass | A waiter on a retired inode cannot mutate a successor Volume envelope. | 329 ms |
| volume-shared-holder-killed | pass | A killed shared holder releases lifecycle exclusion without a PG lease or stale-lock deletion. | 335 ms |
| volume-credential-lock-pg-loss | pass | PG loss cannot release credential-file exclusion while an older callback continues. | 76 ms |
| volume-shared-replaced-envelope | pass | Shared access cannot proceed on an envelope replaced while acquisition was pending. | 326 ms |
| volume-credential-replaced-inode | pass | Credential waiters validate the inner as well as outer inode before mutation. | 322 ms |
| volume-upload-shared-delete-exclusive | pass | Concurrent ordinary operations retain exclusive deletion admission until all existing callbacks settle. | 241 ms |
| volume-concurrent-upload-publish | pass | Shared transfer admission preserves complete non-overwriting placement and content identity. | 119 ms |
| composer-ordinary-send-lost-ack | pass | An unchanged ordinary-send retry reuses the accepted input identity; a confirmed intentional repeat remains possible. | 4 ms |
| composer-cross-action-lost-ack | pass | A successful Steer ends the old ordinary intent; fresh identical input receives a new identity. | 1 ms |
| returned-turn-identity | pass | Returned input ends only its matching unresolved submission; new post-Stop input retains its key. | 1 ms |
| returned-steer-identity | pass | Returned input ends only its matching unresolved submission; new post-Stop input retains its key. | 1 ms |
| returned-input-late-ack | pass | A late ACK cannot erase the fresh returned-input submission identity. | 0 ms |
| upload-staging-sigkill | pass | An OS-released guard authorizes cleanup of owned abandoned staging without another upload or PG claim. | 476 ms |
| upload-staging-published-sigkill | pass | Cleaning an abandoned temporary hard link preserves the already published final file. | 601 ms |
| upload-staging-live-writer | pass | Shared transfer guards permit another writer but refuse cleanup while either writer is alive. | 55 ms |
| upload-staging-locator-replaced | pass | Recovery locators cannot authorize deleting a replacement staging identity. | 101 ms |
| upload-maintenance-lifecycle-isolation | pass | Cleanup errors do not destroy or quarantine VMs, wake paused runtimes or prevent other cleanup candidates. | 12 ms |
| native-input-wake-coalescing | pass | Native/control wake namespaces cannot suppress a newer queue view or cause idle database polling. | 79 ms |
| native-live-closed-anchor | pass | Native completion cannot bypass a requested writer closure or be undone by its late seal. | 6036 ms |
| session-producer-post-init-grant | pass | A producer cannot adopt a grant revoked while initialization was in flight. | 4 ms |
| session-producer-unknown-commit | pass | An uncertain native transaction freezes this producer instead of replaying or reinitializing. | 1 ms |
| session-producer-initialization-close | pass | Shutdown disposes an initializing producer before it can publish. | 52 ms |
| control-publication-backpressure | pass | Control publication rejects overflow before send and releases memory after an unknown ACK. | 4 ms |
| control-publication-replaced-owner | pass | Revoked control owners cannot admit waiting effects to a replacement writer. | 52 ms |
| native-subagent-stop-before-create | pass | A durable native stop receipt rejects a delayed child creation. | 33 ms |
| native-subagent-unsafe-recovery | pass | Cold native recovery restores children without a cloud child Run or unsafe Tool replay. | 21 ms |
| native-child-fork-delete | pass | Native child history supports cold fork and parent-owned deletion without adding cloud task rows. | 6088 ms |
| reply-admission-recovery | pass | Reply dependency failure pauses new claims, preserves active work and recovers without another execution authority. | 106 ms |
| reply-runtime-readiness | pass | Actual Worker composition gates HTTP readiness and claim admission on local reply state, without provider HEAD or aborting current work. | 6707 ms |
| reply-attachment-read-failure | pass | Confirmed reply survives attachment failure; native interruption does not fabricate sandbox loss or cancellation uncertainty. | 101 ms |
| reply-attachment-integrity | pass | Corrupt image bytes never enter native context and do not erase prior execution receipt. | 29 ms |
| reply-stop-during-image | pass | Stop aborts image restoration without retroactively cancelling completed Tools or accepting late content. | 29 ms |
| reply-receipt-deadline-after-image | pass | A satisfied receipt deadline cannot turn a subsequent attachment read into execution UNKNOWN. | 36 ms |
| reply-attachment-stop-after-failure | pass | Native Stop and lost execution/write authority take precedence over an earlier attachment diagnostic. | 26 ms |
| reply-attachment-lease-after-failure | pass | Native Stop and lost execution/write authority take precedence over an earlier attachment diagnostic. | 32 ms |
| reply-attachment-writer-after-failure | pass | Native Stop and lost execution/write authority take precedence over an earlier attachment diagnostic. | 33 ms |
| reply-control-image-failure | pass | Control Tool results share the same receipt and attachment boundary as fixed Tools. | 6 ms |
| reply-stop-before-decoded-return | pass | A late microtask Stop rejects delivery without erasing already confirmed execution receipt. | 4 ms |
| native-coordination-json-boundary | pass | Accepted structured text remains complete through native finalization at the native default limit. | 10 ms |
| native-coordination-escaped-boundary | pass | Native UTF-8 budget is distinct from JSON transport escaping; the final batch remains bounded. | 9 ms |
| native-coordination-line-boundary | pass | A 2000-line result including trailing LF survives native settlement without losing its final decision. | 9 ms |
| native-coordination-oversize | pass | Oversized coordination output is a bounded Tool error and never triggers automatic effect replay. | 22 ms |
| native-result-atomic-ack-recovery | pass | Native result/task/live settlement is atomic; recovery before or after its commit does not replay the unsafe Tool. | 18 ms |
| native-result-malformed-text | pass | Malformed content cannot be marked as known execution settlement or enter native result processing. | 2 ms |
| native-rejected-result-fault | pass | Native rejection does not preserve an uncommitted result or automatically repeat its external effect. | 38 ms |
| native-sequence-without-blobs | pass | A scoped metadata sequence query works independently of image-store availability and avoids body fetches. | 255 ms |
| normal-completion-commit-return-loss | pass | A committed normal terminal is restored on replay without a duplicate event or transition. | 5984 ms |
| normal-completion-cancel-versions | pass | Transaction-local snapshot reuse preserves successive cancellation versions and replay idempotency. | 5956 ms |
| normal-completion-stale-writer | pass | An old work_finished cannot terminate a newly admitted incarnation of the same logical Run. | 6017 ms |
| native-host-no-send-refusal | pass | A definite rejection preserves shared native ownership and the previous committed sequence. | 6135 ms |
| native-host-unknown-ack | pass | Uncertain or post-ACK failure retires the owner, including a wrongly typed no-send callback exception. | 5972 ms |
| native-host-lost-ack-after-commit | pass | Uncertain or post-ACK failure retires the owner, including a wrongly typed no-send callback exception. | 6001 ms |
| native-host-effect-confirmation | pass | Uncertain or post-ACK failure retires the owner, including a wrongly typed no-send callback exception. | 6091 ms |
| native-host-display-confirmation | pass | Uncertain or post-ACK failure retires the owner, including a wrongly typed no-send callback exception. | 5908 ms |
| browser-observation-writer-handoff | pass | Existing execution generations permit same-Run recovery without stale Working or VM state and reject late old observations. | 10 ms |
| browser-event-byte-overflow | pass | Slow-reader overflow releases retained data and requests replacement without stale queued channels. | 4 ms |
| browser-slow-periodic-drain | pass | Partial network progress cannot bypass the pending-byte budget or block another viewer. | 6 ms |
| browser-large-event-replacement | pass | A pending-event budget cannot make a large canonical snapshot permanently undisplayable. | 3 ms |
| browser-commentary-coverage | pass | Commentary compaction preserves live event order, borrowed snapshots and canonical settlement identity. | 26 ms |
| lease-pg-lock-isolation | pass | One busy lease does not block healthy Sessions; an expired deferred lease cannot revive. | 1154 ms |
| lease-local-revoke-before-pg | pass | Local failure admission and cancellation do not await failed PG persistence. | 178 ms |
| lease-checkout-pool-release | pass | An expired checkout releases locks and pool capacity without waiting for user code. | 337 ms |
| lease-lost-commit-reply | pass | Uncertain transaction completion supplies no acknowledgement and is never replayed. | 538 ms |
| lease-connect-timeout | pass | Unresponsive establishment cannot indefinitely consume lease I/O capacity. | 253 ms |
