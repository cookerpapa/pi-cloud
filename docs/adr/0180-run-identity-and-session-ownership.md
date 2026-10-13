# ADR-0180: One Run identity, Session ownership and local capacity

Status: accepted, 2026-09-19. Owner-approved simplification of ADRs 0167,
0174–0179. Kafka projection/seals, native Lane semantics and Workspace deletion
coordination are unchanged in that original revision. Current continuation follows
[ADR-0229](0229-native-durable-runtime.md); root work/native children and one-writer
closure follow [ADR-0247](0247-session-work-and-tool-dispatch.md).

A Run is one admitted root work item, not a retry container. Its native task may
resume after ordered old-writer closure and a fresh PG grant. SQL
transaction retries and provider transport retries are not new business Runs.
Remove RunAttempt, its second state machine, current-attempt pointer and counters.
Run owns execution attribution, publication/coverage, drain and seal evidence.
Never replay arbitrary Tools after uncertainty.

One physical Session owns one Worker boot and one Lease/Fence. Its native writer
identity is the lease incarnation, not a first task's Attempt. Sibling Lanes
share that writer and can execute concurrently. Children have native task outcomes,
not cloud Runs or individual seals. Poisoned writer state belongs to the Session
incarnation. New ownership waits for its one ordered closure. Keep precise post-lock expiry,
ambiguous-COMMIT confirmation and effect-endpoint authority.

Worker capacity is local admission, including pending claims and memory limits.
Remove the durable active-session counter and ready/leased occupancy distinction;
Worker registration/liveness/draining remains durable. PostgreSQL authorizes
which task/Session belongs to the Worker, not how many local slots it believes
it has. KEDA may count leases/ready families; telemetry is not another admission
authority. Children do not occupy additional family slots.

Keep API Workspace validation coordinated with deletion under a short resource
lock. A stale browser cannot grant validity. This is lifecycle coordination, not
filesystem serialization between Sessions.

Use the existing PG transactional queue, unique keys, Session leases and Kafka
append/projection. No new framework, service, cache or compatibility execution
path is introduced. Cut over only with inputs/executions/seals drained, matching
service revisions and a new log-wire version. Preserve semantic history and user
bytes where safely representable; never silently discard incompatible resources.

Acceptance: local pending-claim capacity; same-Lane FIFO and concurrent sibling
Lanes; new owner after all seals; cancelled/failed Run followed by a new Run;
lost COMMIT; late old output/Tool result rejection; Workspace delete/input races;
paid model/Cube multi-round and process-loss recovery; measured admission SQL
and end-to-end latency without weakening durability.
