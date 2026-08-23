# Streaming durability and crash matrix

PiCloud separates short-lived presentation fragments from semantic conversation
state. The following symbols make the boundary explicit:

- `R` — a Worker produced a sequenced raw event;
- `K` — Accepted Kafka durably acknowledged that event after authority checks;
- `V` — an authenticated SSE client observed the event;
- `P` — Pi SessionStorage committed the complete message or Tool result in
  PostgreSQL;
- `T` — PostgreSQL atomically committed the terminal Run state and terminal
  Kafka outbox row.

The maintained invariants are:

```text
V implies K
T(success) implies P
next model Step starts only after the required P projection barrier
arbitrary Tool effects are never inferred from R, K or V
```

`K` is a bounded hot replay fact, not a lifetime transcript. On an accepted
terminal event, every Gateway folds the settled Session tail to that terminal
cursor. An older reconnect reloads `P` from PostgreSQL. This prevents Gateway
memory from growing with old token fragments while retaining durable-before-
visible behavior.

## Failure matrix

| Crash boundary | Visible result | Recovery rule |
| --- | --- | --- |
| before `K` | fragment was never shown | producer may retry with the same event identity |
| after `K`, before `V` | fragment may be unseen | SSE replays from Accepted Kafka |
| after `V`, before complete `P` | visible prefix survives in Kafka | interruption projection stores the bounded visible prefix and abort fact in Pi context |
| complete `P`, before `T` | complete Pi message exists, Run not terminal | stable mutation IDs make projection replay idempotent; terminal settlement retries under the current fence |
| after `T`, before terminal SSE | canonical result is complete | terminal outbox relay republishes; reconnect can reload PostgreSQL |
| Gateway process loss | no canonical loss | rebuild only the retained Kafka suffix; settled tails fold during replay |
| Worker loss during an arbitrary Tool | outcome may be unknown | revoke the fence, record `UNKNOWN`, never auto-run the Tool again |
| Cube loss | process/memory world is gone | persistent Volume keeps files; the next model sees a minimal Sandbox-reset fact |
| PostgreSQL projection lag | live Kafka may continue | the same Session cannot cross its projection barrier into a stale next Step |

The automated contracts cover accepted-order validation, duplicate delivery,
terminal folding, expired cursor reload, terminal outbox idempotence, Pi
mutation projection, interrupted visible-prefix recovery and stale-fence
rejection. Production acceptance additionally restarts Kafka, Control Plane,
Workers and Cube at these boundaries.
