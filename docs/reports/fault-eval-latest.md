# PiCloud deterministic fault evaluation

Generated: 2026-08-23T19:19:26.737Z

Revision: a1334f4f25d1922f9f020804b21c28d608870e3b

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 7051 ms / 7678 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 3330 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 2635 ms |
| stale-kafka-event-authority | pass | A stale Worker may reach Raw Kafka but cannot publish browser-visible Accepted events. | 7560 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 4894 ms |
| session-projection-barrier-before-read | pass | A replacement Worker crosses the Session-keyed projection barrier and rechecks its fence before reading PostgreSQL. | 1063 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 5134 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 4949 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 7333 ms |
| accepted-projection-ahead-of-worker-ack | pass | An Accepted projector that commits before the Worker observes its ACK cannot strand terminal Run settlement. | 7398 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 2955 ms |
| control-channel-expiry-with-live-run | pass | A stale Control Channel cannot retire a Worker whose active RunAttempt still has fresh database authority. | 7051 ms |
| dead-worker-management-unavailable | pass | After connection and lease expiry, a dead management endpoint cannot strand the interrupted Run or Session. | 7219 ms |
| assignment-loss-releases-model-reservation | pass | Worker loss settles its model reservation so the replacement Run does not wait for quota TTL. | 7309 ms |
| terminal-tool-activation-before-next-writer | pass | A replacement writer can synchronously claim and retire the failed Run's fenced Tool activation. | 6033 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 7058 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 7678 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 7556 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 7171 ms |
