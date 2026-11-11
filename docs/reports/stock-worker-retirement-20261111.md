# PiCloud deterministic fault evaluation

Generated: 2026-11-11T03:12:29.186Z

Revision: 73f29525b9d38796a0748e51ab2c2c9715b2a387

Uncommitted changes at test start: no

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 3
- File-group executions: 1; total wall time: 3207 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 3/3 (100.0%)
- p50 / p95: 2 ms / 9 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| worker-inventory-retirement-reachable | pass | Worker inventory retirement revokes routing without cancelling accepted Guest work, independent of endpoint reachability. | 2 ms |
| worker-inventory-retirement-confirmed | pass | Worker inventory retirement revokes routing without cancelling accepted Guest work, independent of endpoint reachability. | 1 ms |
| shared-binding-explicit-cancellation | pass | Explicit cancellation still applies to the selected binding while its sibling and shared VM remain available. | 9 ms |
