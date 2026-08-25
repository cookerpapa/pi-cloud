# Streaming durability and crash matrix

PiCloud separates short-lived presentation fragments from semantic conversation
state. The following symbols make the boundary explicit:

- `R` — a Worker produced a sequenced raw event;
- `J` — R=3 JetStream durably acknowledged that event inside a batched,
  transaction-scoped ExecutionGrant authority boundary;
- `V` — an authenticated SSE client observed the event;
- `P` — Pi SessionStorage committed the complete message or Tool result in
  PostgreSQL;
- `T` — PostgreSQL atomically committed the terminal Run state and terminal
  event outbox row.
- `B` — the Session-keyed mutation projection barrier committed after all
  earlier mutation records reached an applied-or-fenced outcome.

The maintained invariants are:

```text
V implies J
T(success) implies P
next model Step starts only after the required P projection barrier
replacement Worker reads SessionStorage only after B and a fresh fence check
arbitrary Tool effects are never inferred from R, J or V
```

`J` is a bounded hot replay fact, not a lifetime transcript. JetStream retains
the Session Subject while PostgreSQL owns settled semantic messages. An older
reconnect reloads `P` from PostgreSQL. Gateway memory therefore follows active
HTTP connections rather than historical token fragments.

JetStream durability and browser presentation are deliberately decoupled. React first
accepts the complete `J`-acknowledged text block into its in-memory target, then
reveals that target over bounded animation frames. Later semantic events remain
authoritative and refresh/reconnect still renders the complete durable target;
the animation is neither another event log nor another acknowledgement. Hidden
tabs and reduced-motion clients skip the animation, and manual scrolling stops
automatic tail following while the local reveal continues.

Gateway startup installs one committed-RePublish Core NATS subscription. It
does not scan retained history. Reconnect creates a temporary exact-Subject
consumer bounded by per-Session message count and retention; older settled
conversations are already canonical in PostgreSQL.

## Failure matrix

| Crash boundary | Visible result | Recovery rule |
| --- | --- | --- |
| before `J` | fragment was never shown | producer may retry with the same event identity |
| after `J`, before `V` | fragment may be unseen | SSE replays the exact JetStream Session Subject |
| after `V`, before complete `P` | visible prefix survives in JetStream | interruption projection stores the bounded visible prefix and abort fact in Pi context |
| complete `P`, before `T` | complete Pi message exists, Run not terminal | stable mutation IDs make projection replay idempotent; terminal settlement retries under the current fence |
| after `T`, before terminal SSE | canonical result is complete | terminal outbox relay republishes; reconnect can reload PostgreSQL |
| Gateway process loss | no canonical loss | reconnect reads the retained Session Subject; no process cache is authoritative |
| Worker loss during an arbitrary Tool | outcome may be unknown | revoke the fence, record `UNKNOWN`, never auto-run the Tool again |
| Worker process is unreachable after its lease expires | management stop cannot be confirmed over the dead endpoint | durable fence blocks every later effect; settle the Run and outstanding model reservations, return the Session to idle and retire the logical owner without adopting its process |
| Cube loss | process/memory world is gone | persistent Volume keeps files; the next model sees a minimal Sandbox-reset fact |
| PostgreSQL projection lag | live JetStream may continue | the same Session cannot cross its projection barrier into a stale next Step |
| Worker replacement with mutation records in flight | old records precede the keyed barrier | wait for `B`, recheck the new fence, then read PostgreSQL |

The automated contracts cover accepted-order validation, duplicate delivery,
terminal folding, expired cursor reload, terminal outbox idempotence, Pi
mutation projection, interrupted visible-prefix recovery and stale-fence
rejection. Production acceptance additionally replaces a JetStream Leader, Control Plane,
Workers and Cube at these boundaries.
