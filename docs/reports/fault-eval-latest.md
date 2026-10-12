# PiCloud deterministic fault evaluation

Generated: 2026-10-12T02:56:06.379Z

Revision: 72cbe218ba18060bd42fefa1cd75df4f55fa8d71

Uncommitted changes at test start: yes

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 247
- File-group executions: 72; total wall time: 436084 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 247/247 (100.0%)
- p50 / p95: 65 ms / 6679 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| publication-known-closed-registration | pass | A known closed Run is rejected without a database dependency or a new Kafka write. | 7 ms |
| publication-known-old-registration | pass | A replaced writer cannot reopen its Run and is rejected from the current owner's memory. | 1 ms |
| publication-positive-cache-needs-pg | pass | An open cached identity cannot bypass current PG authorization when registering again. | 2 ms |
| publication-replacement-registration-needs-pg | pass | A replacement ingress with empty memory cannot grant admission while PG is unavailable. | 1 ms |
| publication-evicted-registration-needs-pg | pass | Evicting a closed identity cannot turn an old grant into permission to reopen it. | 1 ms |
| stale-accepted-fact-authority | pass | A record cannot install its own authority or bypass the PG-issued publication scope. | 1 ms |
| native-record-oversize-isolation | pass | Oversized individual publications fail before entering the bounded publication queue. | 4 ms |
| publication-seal-order | pass | Ingress closes old admission before draining and a successor cannot pass the ordered seal. | 106 ms |
| publication-stale-admission | pass | A delayed PG grant cannot reopen a scope after its closure completed. | 1 ms |
| publication-uncertain-queued-data | pass | Unknown semantic commit stops queued data while preserving ordered closure. | 1 ms |
| publication-lost-seal-ack | pass | PG canonical seal evidence releases a successor despite a lost producer ACK. | 1 ms |
| subagent-native-task-admission | pass | An invalid Tool identity is refused before Kafka and cannot poison the Session writer. | 2 ms |
| guest-deleted-working-directory | pass | A confirmed missing user directory returns a native Tool error without command effects or implicit directory repair; explicit restoration permits new work. | 1109 ms |
| guest-working-directory-replaced-by-file | pass | Non-directory paths fail before Tool execution without changing existing bytes or choosing another cwd. | 1056 ms |
| guest-working-directory-unexpected-failure | pass | Only known missing-path failures are ordinary results; other filesystem preparation failures retain infrastructure classification. | 531 ms |
| guest-running-command-directory-deletion | pass | Directory deletion does not retroactively cancel a running command or permit a later command to start in a missing cwd. | 3082 ms |
| completion-directory-native-error | pass | Completion retains the original native Tool error and callback identity rather than manufacturing an UNKNOWN transport failure. | 2 ms |
| completion-attachment-remains-unknown | pass | Workspace attachment failure is not downgraded into an ordinary directory error. | 1 ms |
| completion-guest-failure-remains-unknown | pass | An unexpected guest execution failure retains uncertain effects and the existing sampling guard. | 0 ms |
| started-cancel-outcome-unknown | pass | Interruption after native execution may have effects; only explicit before-start cancellation proves no execution. | 0 ms |
| native-harness-directory-error-continuation | pass | Pi Harness persists the directory Tool error and makes the next model request without marking the executor unavailable. | 14 ms |
| tool-reply-publication-failure | pass | Failed publication retires the pending image-adapter callback without crashing unrelated Worker families. | 2 ms |
| tool-reply-before-publication-ack | pass | Early reply rejection stays observed until command publication settles and never triggers an effect replay. | 1 ms |
| native-read-harness-diagnostics | pass | The canonical Tool result and model context retain continuation guidance after native content bounding. | 41 ms |
| input-admission-wait-retry | pass | A waiting replica reads the committed idempotency record after acquiring the Session lock and returns the same Run. | 181 ms |
| input-admission-wait-conflict | pass | A waiting request with changed content cannot reuse an input key or allocate another Run. | 98 ms |
| input-admission-model-first | pass | Input waiting for a model change freezes the newly committed Session selection. | 118 ms |
| input-admission-input-first | pass | A model change waiting behind admission cannot change the model of an accepted queued Run. | 101 ms |
| input-admission-rollback-lifetime | pass | Rollback removes Run and mailbox advancement; escaped actions cannot reuse ended transaction authority. | 74 ms |
| input-admission-workspace-deletion | pass | Reusing the Session read does not bypass a subsequent Workspace availability check. | 40 ms |
| input-admission-tenant-scope | pass | The reused admission scope cannot create or deliver an input for a mismatched tenant. | 36 ms |
| native-input-unavailable | pass | Unconfirmed delivery leaves one cloud execution and no second durable payload queue. | 380 ms |
| native-input-lost-confirmation | pass | A lost native ACK or edit response cannot duplicate input or restore obsolete text; cold history includes consumed human content. | 538 ms |
| native-input-stale-edit | pass | Native queue edits and consumption share one commit line; intervening reorder prevents stale overwrite. | 426 ms |
| native-input-page-revision | pass | Only pending input changes invalidate an edit/pagination revision. | 1293 ms |
| native-input-stop-seal | pass | Stop restores unconsumed input after closure and rejects premature acknowledgement. | 631 ms |
| native-input-consumed-stop | pass | Consumed native submissions cannot be restored as unsent drafts. | 470 ms |
| native-input-return-pages | pass | One browser acknowledging a returned batch cannot truncate another browser restoring its pages. | 1374 ms |
| initial-input-edit-claim | pass | An initial-input mutation conflicts with a Worker claim instead of deadlocking or changing admitted input. | 70 ms |
| initial-input-cancel-claim | pass | An initial-input mutation conflicts with a Worker claim instead of deadlocking or changing admitted input. | 74 ms |
| initial-input-move-claim | pass | An initial-input mutation conflicts with a Worker claim instead of deadlocking or changing admitted input. | 72 ms |
| projection-replay-stable-tuples | pass | Replayed coverage and partition progress preserve tuple versions, native bytes, monotonic cursors and the first recovery floor. | 308 ms |
| projection-display-missing-native | pass | A no-op coverage replay still requires the referenced canonical native commit. | 157 ms |
| projection-run-cutoff-wait | pass | Native projection locks the Run before the shared writer and rechecks the Run cutoff after waiting. | 137 ms |
| projection-writer-cutoff-wait | pass | Native projection rechecks a concurrently committed writer cutoff before writing history or advancing recovery progress. | 164 ms |
| projection-display-concurrent-advance | pass | A waiting coverage statement sees the current locked Run and neither regresses nor rewrites a newer cursor. | 172 ms |
| projection-lock-timeout-replay | pass | Server lock timeout leaves native history and projection positions unchanged; redelivery after release applies once. | 241 ms |
| projection-statement-timeout | pass | A timed-out SQL statement rolls back preceding writes and transaction-local timeout settings. | 116 ms |
| expired-owner-at-run-admission | pass | Final admission checks current PG time after locks; an expired lease cannot start the Agent or leave partial owner state. | 65 ms |
| cancel-native-projection-locks | pass | Cancellation lifecycle locks remain compatible with the native Record's Turn foreign key, so neither side deadlocks. | 244 ms |
| cancel-settlement-sql-abort | pass | A certified cancellation-settlement SQL abort retries only that transaction, never the external stop or Agent Loop. | 289 ms |
| ready-seal-atomicity | pass | A failed seal commit cannot release the next Lane task or decrement the family count; replay decrements once. | 156 ms |
| ready-input-before-seal | pass | Input acceptance and seal projection serialize on the Lane row and cannot leave a committed follow-up permanently waiting. | 244 ms |
| ready-seal-before-input | pass | Input waiting behind a seal transaction observes the committed closure and becomes ready without another notification. | 245 ms |
| first-record-commit-reply-loss | pass | A lost PG COMMIT reply preserves the first recovery floor and idempotent native projection. | 149 ms |
| first-record-rollback | pass | First native data and its recovery floor roll back together, and retry cannot skip the prefix. | 157 ms |
| durable-tool-draft-publication | pass | Streaming Tool drafts never enter native commits; complete calls execute only after their validated intent is acknowledged. | 187 ms |
| durable-tool-draft-provider-mutation | pass | Provider mutation cannot insert Tool arguments into an earlier partial already delivered to Durable. | 205 ms |
| durable-tool-draft-stop | pass | Stopping an incomplete call retains committed text without persisting arguments, executing the Tool or inventing a result. | 105 ms |
| durable-tool-draft-recovery | pass | Recovery resumes the original input without replaying or retaining an incomplete Tool call. | 155 ms |
| execution-probe-no-allocation | pass | Probes never allocate a VM; an expected missing binding is unavailable, not silently not-applicable. | 55 ms |
| execution-probe-fast-reply | pass | A fast complete return cannot be overwritten by a later admission receipt. | 102 ms |
| execution-probe-stale-identity | pass | Current scope, target and deadline are required for fresh evidence; unknown transport never authorizes resource recovery. | 53 ms |
| execution-probe-projector-reset | pass | Pending observations cannot survive Projector ownership reset as fresh acknowledgements. | 51 ms |
| runtime-probe-partial-inventory | pass | Partial inventory or failed guest responses cannot authorize VM destruction or quota release. | 1 ms |
| runtime-probe-fleet-coverage | pass | Every due physical runtime is examined without a 16-item truncation or unbounded concurrent requests. | 62 ms |
| execution-probe-independent-paths | pass | Missing guest replies do not block publication, native drain or future log-path probes; replaced bindings reject late evidence. | 8 ms |
| path-probe-stalled-ack | pass | At most one probe is outstanding per physical Session; a probe has no semantic commit to recover. | 2 ms |
| machine-rebind-release-race | pass | A pending machine release wins over a stale target lookup; rebinding checks a fresh snapshot after the machine lock. | 109 ms |
| machine-rebind-identity-and-retry | pass | Binding replay cannot duplicate or retarget the operation; native Session/model identity and previously accepted Run snapshots remain unchanged. | 218 ms |
| lease-sweep-independent-of-retirement | pass | A stalled remote stop cannot stall lease scanning; drain prevents another cleanup claim. | 35 ms |
| lease-sweep-pg-time | pass | Both initial expiry selection and final retirement use PG time, independent of API clock skew. | 4684 ms |
| path-probe-stale-replay | pass | A replay or stale probe cannot refresh liveness or create an active execution scope. | 7 ms |
| activity-writer-seal | pass | Tenant, partition and owner checks fence phase observations; a writer seal closes all sibling observations. | 5 ms |
| activity-terminal-sse | pass | Transient activity cannot alter transcript sequence or reopen a terminal turn. | 6 ms |
| upload-expiry-late-completion | pass | Expired drafts release image pins; a revoked upload cannot become a ready input after a late external reply. | 195 ms |
| upload-stream-gc-pin | pass | Streaming uploads exceed former product quotas while image reachability is pinned before final publication; GC cannot remove an active source. | 324 ms |
| upload-stream-digest-rejection | pass | A declared content digest is verified against the actual stream before ready metadata is published. | 35 ms |
| upload-symlink-confinement | pass | Upload placement cannot follow a substituted directory or destination link outside the authorized root. | 52 ms |
| upload-stream-truncation-cancel | pass | Truncated, overlong or cancelled transfers leave no partial published file, including above the former upload size limit. | 1129 ms |
| input-image-guest-cancel | pass | Input preparation is fenced independently of Agent Tool execution and remains tracked until guest cancellation finishes. | 32 ms |
| subagent-compute-scope-expiry | pass | Expiring a child's independent compute scope keeps the shared Volume and the active parent's runtime; each binding uses its own frozen cwd. | 4 ms |
| cancel-routing-publication-failure | pass | Agent cancellation revokes routing without stopping Cube processes; publication failure retains metadata and VM quota. | 52 ms |
| shared-runtime-loss | pass | A lost shared VM closes every binding and local admission even when closure publication is unavailable. | 4 ms |
| broker-shutdown-admission | pass | Broker shutdown rejects pending VM creation before freeing existing capacity; it never launches the waiter during teardown. | 53 ms |
| recovery-closure-pending | pass | Pending ordered closure neither quarantines a verified shared VM nor exposes partial local binding restoration. | 5 ms |
| allocation-preflight-not-absence | pass | Local preflight rejection cannot release an earlier uncertain same-ID allocation; closure and physical confirmation remain required. | 2 ms |
| projection-independent-cancel | pass | Cancelling a cold history waiter does not cancel the shared progress read or a sibling. | 55 ms |
| projection-owner-cache-fence | pass | Previously observed progress cannot authorize a retired owner or cache a failed read. | 26 ms |
| projection-other-partition-progress | pass | A blocked delivery in one partition does not serialize unrelated partition handlers. | 51 ms |
| atomic-tool-replay | pass | Native intent projects before effect admission; replay never reissues the combined command. | 58 ms |
| atomic-tool-projection-failure | pass | Failed native projection cannot commit or dispatch its Tool command. | 3 ms |
| atomic-tool-commit-failure | pass | An unconfirmed Kafka dispatch commit cannot issue a Tool effect. | 1 ms |
| atomic-tool-rebalance | pass | Lost partition ownership after commit does not dispatch a new effect. | 1 ms |
| atomic-tool-seal | pass | An invocation after its scope seal cannot dispatch a Tool command. | 1 ms |
| projector-seal-replay | pass | Seal projection replay cannot duplicate a terminal or repeat execution closure; closure precedes publication. | 1 ms |
| projector-rebalance-after-pg | pass | A no-longer-current consumer handler cannot continue live or Tool delivery after its pending PG operation completes. | 1 ms |
| worker-local-pending-capacity | pass | Local pending reservations bound overlapping claims without a PG slot counter; successors still wait for closure. | 699 ms |
| ready-family-owner-handoff | pass | A ready main Lane cannot acquire a new owner until the old sibling's final seal commits. | 5915 ms |
| cancel-pg-clock | pass | PG due time, claims and retries remain correct under application clock skew and concurrent dispatch. | 6628 ms |
| quarantine-exit-first | pass | Missing or stale execution exit/seal proof never authorizes recovery, independently of native input consumption. | 6931 ms |
| quarantine-seal-first | pass | Missing or stale execution exit/seal proof never authorizes recovery, independently of native input consumption. | 6845 ms |
| quarantine-no-exit-proof | pass | Missing or stale execution exit/seal proof never authorizes recovery, independently of native input consumption. | 6661 ms |
| interrupted-framed-snapshot | pass | A partial snapshot never appears in the browser or leaks into the replacement snapshot. | 21 ms |
| duplicate-command | pass | Duplicate delivery does not execute one Agent command twice. | 5 ms |
| stale-execution-reference | pass | A released task cannot reuse its execution reference under a retired Session owner. | 1 ms |
| terminal-tail-unload | pass | Terminal projection unloads shared live-tail memory without invalidating an in-flight browser snapshot. | 3 ms |
| control-plane-process-sigkill | pass | Control Plane process replacement does not revoke a healthy Agent Loop. | 161 ms |
| stale-worker-socket | pass | A stale Worker Control Channel cannot reclaim current ownership. | 339 ms |
| abandoned-development-environment | pass | A Control Plane failure before provisioning cannot leak a requested development machine. | 45 ms |
| sandbox-control-owner-fence | pass | A replacement Sandbox control fences the expired owner before serving its Workspace runtime. | 6545 ms |
| quarantine-stale-physical-target | pass | A delayed old VM quarantine cannot rewrite its replacement identity or close replacement bindings. | 6705 ms |
| binding-view-owned-capacity | pass | Foreign partition payloads do not consume owner bootstrap row or byte budgets. | 6840 ms |
| agent-routing-retirement | pass | Routing retirement requires closure, isolates the exact Run even with a shared binding ID, and requires no Cube process receipt. | 6616 ms |
| controller-shutdown-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 6679 ms |
| controller-expiry-preserves-cube | pass | Controller ownership loss preserves capsule-backed VM state/bindings for verified adoption; actual physical uncertainty still closes them atomically. | 6569 ms |
| adoption-notification-outage | pass | Verified VM adoption and confirmed binding retirement survive notification outages through durable Outbox propagation. | 6732 ms |
| tool-cancel-retired-binding | pass | Durable cleanup intent survives Worker loss and routing-row retirement without a process-stop receipt table. | 6581 ms |
| allocation-intent-recovery | pass | Creation authorization and configuration survive controller loss; closure is irreversible and late completion cannot reopen the resource. | 6873 ms |
| allocation-unissued-closure | pass | Closing before authorization blocks later materialization without inferring physical absence from an inventory miss. | 6571 ms |
| allocation-legacy-uncertainty | pass | Historical missing allocation identity never becomes invented absence or quota release. | 6714 ms |
| controller-total-transaction-budget | pass | PG terminates overlong lifecycle transactions, frees ownership locks and retires the failed connection. | 7033 ms |
| ambiguous-tool-transport | pass | An ambiguous Tool transport never blindly replays an arbitrary command. | 2 ms |
| quarantined-binding-late-command | pass | Durable routing closure rejects later Tool handoffs after dispatcher replacement without cancelling previously accepted processes. | 1 ms |
| tool-cancel-revoked-route | pass | Routing revocation blocks new work without blocking idempotent cancellation of an existing operation. | 4 ms |
| tool-cancel-unavailable-executor | pass | Executor communication failure never authorizes VM deletion or shell replay. | 2 ms |
| workspace-volume-delete-race | pass | Workspace bytes are not deleted while a live Cube still owns the Volume. | 4657 ms |
| tool-commit-before-effect | pass | A Tool command cannot dispatch until Kafka confirms its monotonic commit boundary. | 12 ms |
| tool-replay-without-effect | pass | Rebuilding volatile display state does not replay already committed Tool commands. | 14 ms |
| partition-progress-isolation | pass | One pending partition cannot hold periodic progress of another partition across ticks. | 2001 ms |
| tool-native-late-result | pass | Completing guest work after closure cannot publish a usable native Tool result. | 6 ms |
| image-cleanup-composite-identity | pass | Image cleanup mutates only the tenant/object identities it locked, preserving another tenant's unexpired object. | 28 ms |
| image-upload-and-cleanup-failure | pass | Failed uploads cannot be retained; cleanup claims survive remote deletion failure. | 67 ms |
| image-unprojected-retention | pass | Kafka-acknowledged but unprojected images remain protected by their unsealed source Run. | 103 ms |
| image-cleanup-reference-race | pass | A deleting attachment cannot gain a canonical native reference. | 27 ms |
| image-cross-tenant-integrity | pass | A hash or tenant mismatch never becomes a successful native image. | 12 ms |
| image-native-fork-retention | pass | Cold reads and independent native Fork history retain the exact image bytes. | 286 ms |
| input-image-consumer-closure | pass | Consumer failure/early return never certifies an incomplete image and closes its source. | 15 ms |
| tool-reply-progress-rejected | pass | Observation-only progress cannot enter the final-result Kafka transport. | 2 ms |
| tool-reply-worker-loss | pass | A replacement Worker cannot attach an old operation's replies to a new Tool call. | 0 ms |
| broker-adopted-capacity | pass | Existing adopted machines count against a lowered capacity; new work remains queued until a physical slot is free. | 53 ms |
| gitlab-note-business-lock-release | pass | Provider HTTP holds no business transaction or row lock; one current note-sync claim does not block claim changes or ordinary Run admission. | 332 ms |
| gitlab-note-uncertain-create | pass | An uncertain remote create remains pending; marker readback recovers the applied note without repeating its creation in the tested lost-reply case. | 123 ms |
| gitlab-note-late-write | pass | Local claim fencing rejects a stale acknowledgement, and periodic remote verification repairs its late external write even after PG considered the latest version synced. | 183 ms |
| gitlab-note-ack-expiry | pass | Synchronization acknowledgement uses PG decision time after locking; a lease that expires while waiting cannot confirm remote output. | 608 ms |
| workflow-result-budget | pass | A completed oversized workflow return becomes an explicit bounded error without repeating effects. | 51 ms |
| lease-batch-renewal-race | pass | An older lookup cannot revoke ownership confirmed by a newer committed renewal. | 0 ms |
| lease-batch-one-second-revocation | pass | Sharing heartbeat evidence does not slow periodic PG revocation observation. | 9 ms |
| lease-batch-no-revival | pass | Missing renewal retires the reported family while retaining other families; later replies cannot revive it. | 1 ms |
| lease-batch-read-failure | pass | A failed batch read fails closed for every owner in that observation. | 1 ms |
| lease-batch-incarnation | pass | Closing a lease observer prevents stale reads from affecting a later local incarnation. | 1 ms |
| indexed-log-quiescent-cutover | pass | An unsettled Session prevents schema cutover; settled cutover retains immutable bodies and never resurrects deleted Turn bindings. | 6528 ms |
| direct-steer-fk-locks | pass | Native input RPC holds no cloud admission transaction; concurrent foreign-key references do not deadlock intake. | 6810 ms |
| binding-view-stale-read | pass | A late binding read cannot reopen a deleted route. | 4 ms |
| binding-view-reassignment | pass | Old snapshots cannot repopulate a new partition owner. | 2 ms |
| binding-old-publication-revocation | pass | An old unsent open reference cannot hide a current PG revocation. | 1 ms |
| ordered-closure-open-fact | pass | Only the closed Kafka fact closes workflow orchestration; a newer PG revocation seen through an older fact is not a workflow command. | 1 ms |
| queue-view-snapshot-race | pass | Queue presentation never regresses after a newer committed change. | 52 ms |
| queue-view-read-isolation | pass | Disposable queue reads cannot hold ordered projection or another watched Session. | 55 ms |
| queue-view-reset-capacity | pass | Owner changes retain read-slot bounds and discard old completions; overflow requests resynchronization. | 52 ms |
| subagent-view-late-read | pass | A stale Subagent read cannot overwrite a newer family view. | 4 ms |
| subagent-pending-input-reference | pass | Evicting a body cannot discard durable unconsumed Agent input. | 1 ms |
| outbox-independent-send-and-cleanup | pass | One slow Session publication or cleanup cannot block other send slots, expired local claims are not duplicated, and cleanup drains multiple bounded batches. | 9257 ms |
| publication-readiness-assignment-replacement | pass | Old readiness replies cannot survive local ownership replacement; unready partitions remain queued. | 55 ms |
| publication-readiness-expiry | pass | A stalled readiness check cannot indefinitely authorize new Run admission. | 4 ms |
| control-change-concurrent-revision | pass | Transaction coalescing retains the post-lock revision so concurrent input invalidations cannot hide the final state. | 129 ms |
| subagent-noop-notification | pass | A conflicting no-op INSERT never publishes an imaginary source mutation. | 129 ms |
| control-coalescing-logical-restore | pass | Retained or logically restored references cannot collide with a new transaction; connection reuse and savepoint rollback clear temporary identity. | 79 ms |
| upload-owner-change-no-replay | pass | Ownership is resolved before byte consumption; a later redirect never implicitly replays a consumed upload stream. | 250 ms |
| worker-unlimited-memory-admission | pass | An unlimited cgroup cannot suppress all claims; real physical memory pressure and stale evidence still stop new-family admission. | 4 ms |
| upload-publication-parser-isolation | pass | Removing upload body limits cannot turn internal native publication frames into unparsed streams or remove their transport envelope. | 55 ms |
| streamed-s3-receipt-deadline | pass | A stalled receipt cannot renew upload claims indefinitely; progressing transfers retain their lifetime. | 286 ms |
| streamed-s3-body-abort | pass | Cancellation closes an S3 body even after HTTP headers have resolved. | 11 ms |
| presentation-pool-deadline | pass | Display queries have server deadlines and separate connection capacity from authority mutations. | 523 ms |
| verification-overlap | pass | A verification result cannot certify a mutation still running or completed after its start. | 2 ms |
| tool-cancel-setsid-survival | pass | Normal Agent cancellation preserves independent setsid processes rather than killing the whole operation cgroup. | 66 ms |
| tool-cancel-completed-background | pass | Esc targets unfinished Tools, never background services left by completed calls. | 61 ms |
| native-read-long-multibyte-line | pass | Bounded Read retains a UTF-8-safe file prefix and native byte continuation diagnostics. | 28 ms |
| allocation-lost-create-reply | pass | Lost creation replies resolve by the original allocation, without allocating another VM. | 31 ms |
| allocation-late-create | pass | A delayed create cannot reopen a previously closed allocation. | 7 ms |
| controller-resource-renewal-isolation | pass | A blocked resource cannot revoke a healthy controller or block unrelated Workspace lifecycle work. | 8924 ms |
| controller-terminal-renewal-isolation | pass | Owner renewal does not depend on terminal resource-row maintenance. | 8786 ms |
| workflow-unknown-stops-sampling | pass | Unknown Workflow effects prevent a second model request without shell replay. | 15 ms |
| workflow-socket-loss-stops-sampling | pass | An unconfirmed Workflow connection close is a typed infrastructure failure. | 13 ms |
| workflow-business-error-continues | pass | Ordinary script errors cannot be mistaken for infrastructure loss by their text. | 47 ms |
| durable-ack-visibility | pass | Projection visibility cannot turn an unacknowledged publication into adopted native state; ambiguous ownership refuses further commits. | 68 ms |
| durable-proved-refusal | pass | Certified pre-enqueue refusal preserves sequence; conflicting duplicate bodies cannot change native state. | 35 ms |
| durable-document-tail | pass | Derived document checkpoints bound cold reconstruction without changing native history or delta counts. | 1302 ms |
| durable-paused-projection | pass | ACKed progress remains available through PG lag and cold reads remain scoped to the requested suffix. | 179 ms |
| durable-no-hot-sql | pass | Ordinary warm native commits do not add per-Step PG receipts. | 165 ms |
| durable-native-image-locations | pass | Native images remain immutable references across new record and document locations and cold decoding. | 525 ms |
| durable-origin-recovery | pass | A cleanup owner cannot reassign the original task/result provenance. | 52 ms |
| durable-budget-floor | pass | Recovery cannot refill finite Run budgets; abort-mark duplicates do not consume another native intent. | 55 ms |
| durable-complete-document-overlay | pass | Complete acknowledged documents need no projection revision query; incomplete and historical overlays retain PG reconstruction. | 1260 ms |
| native-live-stream-retention | pass | Streaming payloads stay in Kafka while acknowledged native current reads survive ordinary PG-buffer flushes. | 1096 ms |
| native-live-replay-handoff | pass | Replay detects gaps and changed bytes; a handoff preserves exact native state without allocating a native sequence. | 162 ms |
| native-live-rollback | pass | SQL rollback advances neither authoritative recovery references nor adopted Projector memory. | 45 ms |
| native-live-lost-ack | pass | Lost acknowledgement poisons the old writer but does not discard an accepted partial during native recovery. | 63 ms |
| native-live-interleaving | pass | One Conversation settling never discards another Conversation's in-flight state in the same physical Session. | 98 ms |
| durable-shared-host | pass | One physical writer serves sibling Conversations and preserves acknowledged native state during scoped close and cold restore. | 452 ms |
| durable-display-coverage | pass | Display coverage requires its committed native sequence and cannot mutate an existing snapshot. | 113 ms |
| durable-projection-replay | pass | Native projection redelivery preserves one exact canonical commit. | 131 ms |
| durable-post-seal-refusal | pass | A sealed writer cannot append late native state. | 177 ms |
| native-live-seal-gate | pass | Writer closure waits for complete live reconstruction and commits its exact checkpoint before replacement. | 228 ms |
| native-live-closed-anchor | pass | A closed publication anchor cannot release a sibling live suffix or suppress its read-only recovery. | 168 ms |
| durable-unsafe-recovery | pass | Native recovery never replays unsafe Tool effects and cannot request a model before PG-authorized binding. | 41 ms |
| durable-native-cancel | pass | Ordered physical cancellation accompanies native abort; late physical results never overwrite that settlement. | 10 ms |
| durable-validated-intent | pass | One native execute checkpoint authorizes the exact validated remote arguments without persisting model credentials. | 37 ms |
| durable-invalid-arguments | pass | Native validation failure does not prepare or dispatch external effects. | 12 ms |
| durable-child-generation-reply | pass | The native generation owns delegated Conversations: returning a blocked Tool permits a parent reply, while parent abort still cancels child work. | 20 ms |
| durable-child-generation-abort | pass | The native generation owns delegated Conversations: returning a blocked Tool permits a parent reply, while parent abort still cancels child work. | 14 ms |
| durable-same-run-recovery | pass | Replacement retains logical Run/Turn identity, waits for old closure and rejects stale owner callbacks. | 316 ms |
| durable-stop-before-recovery-seal | pass | A Stop racing old-owner closure is preserved for the replacement owner without consuming the queued input. | 227 ms |
| durable-stop-after-recovery-seal | pass | A Stop after recovery closure cannot be lost between queued and admitted native ownership. | 213 ms |
| durable-model-slot-release | pass | A remote Tool wait does not hold a model permit or create a second handoff. | 94 ms |
| durable-verification-recovery | pass | Verification is derived from native history at yield and its continuation cannot duplicate after recovery. | 62 ms |
| durable-fork-documents | pass | Independent forks honor native document cutoff/current semantics without copying execution grants. | 236 ms |
| durable-active-tool-query | pass | Plain conversation reads show the committed native Tool execute checkpoint without waiting for its final result or creating another Tool ledger. | 107 ms |
| native-tree-bounded-prefix-copy | pass | Navigation omits unrelated Tool payloads while an independent Fork preserves the full selected native prefix. | 436 ms |
| native-index-text-backfill | pass | Index backfill/rebuild leaves canonical JSON text exact and refuses outdated metadata writes. | 216 ms |
| durable-active-tool-uncovered | pass | A durable executing Tool can be queried before display coverage without replaying uncovered assistant text. | 98 ms |
| durable-compaction-reopen-summarize | pass | Recovered native Compaction uses its committed Task identity only after a fresh cloud grant; Stop cannot dispatch a held model request. | 34 ms |
| durable-compaction-reopen-retry | pass | Recovered native Compaction uses its committed Task identity only after a fresh cloud grant; Stop cannot dispatch a held model request. | 11 ms |
| durable-compaction-reopen-stop | pass | Recovered native Compaction uses its committed Task identity only after a fresh cloud grant; Stop cannot dispatch a held model request. | 6 ms |
| durable-terminal-snapshot-identity | pass | Dropped start events cannot lose or shift sampling completion identity. | 2 ms |
| durable-recovered-partial-identity | pass | An old interrupted partial cannot consume the replacement request identity. | 0 ms |
| durable-retry-before-final | pass | Retry progress belongs to the request whose native terminal has not been displayed yet. | 1 ms |
| volume-lock-holder-killed | pass | A live filesystem callback owns exclusion independently of the acquisition utility; process death releases its descriptor. | 385 ms |
| volume-lock-pg-loss | pass | PG connection loss cannot let a new filesystem callback overlap the old holder. | 81 ms |
| volume-lock-replaced-inode | pass | A waiter on a retired inode cannot mutate a successor Volume envelope. | 379 ms |
| volume-shared-holder-killed | pass | A killed shared holder releases lifecycle exclusion without a PG lease or stale-lock deletion. | 388 ms |
| volume-credential-lock-pg-loss | pass | PG loss cannot release credential-file exclusion while an older callback continues. | 80 ms |
| volume-shared-replaced-envelope | pass | Shared access cannot proceed on an envelope replaced while acquisition was pending. | 430 ms |
| volume-credential-replaced-inode | pass | Credential waiters validate the inner as well as outer inode before mutation. | 373 ms |
| volume-upload-shared-delete-exclusive | pass | Concurrent ordinary operations retain exclusive deletion admission until all existing callbacks settle. | 233 ms |
| volume-concurrent-upload-publish | pass | Shared transfer admission preserves complete non-overwriting placement and content identity. | 129 ms |
| composer-ordinary-send-lost-ack | pass | An unchanged ordinary-send retry reuses the accepted input identity; a confirmed intentional repeat remains possible. | 5 ms |
| composer-cross-action-lost-ack | pass | A successful Steer ends the old ordinary intent; fresh identical input receives a new identity. | 1 ms |
| returned-turn-identity | pass | Returned input ends only its matching unresolved submission; new post-Stop input retains its key. | 1 ms |
| returned-steer-identity | pass | Returned input ends only its matching unresolved submission; new post-Stop input retains its key. | 1 ms |
| returned-input-late-ack | pass | A late ACK cannot erase the fresh returned-input submission identity. | 1 ms |
| upload-staging-sigkill | pass | An OS-released guard authorizes cleanup of owned abandoned staging without another upload or PG claim. | 509 ms |
| upload-staging-published-sigkill | pass | Cleaning an abandoned temporary hard link preserves the already published final file. | 640 ms |
| upload-staging-live-writer | pass | Shared transfer guards permit another writer but refuse cleanup while either writer is alive. | 62 ms |
| upload-staging-locator-replaced | pass | Recovery locators cannot authorize deleting a replacement staging identity. | 105 ms |
| upload-maintenance-lifecycle-isolation | pass | Cleanup errors do not destroy or quarantine VMs, wake paused runtimes or prevent other cleanup candidates. | 16 ms |
| native-input-wake-coalescing | pass | Native/control wake namespaces cannot suppress a newer queue view or cause idle database polling. | 79 ms |
