# Worker handoff validation through the public API

The earlier late-publisher probe replaced authority directly in a fixture. This
follow-up must establish whether the problematic ordering is reachable through
the actual Run lifecycle. No SQL writes to Run/Attempt/Lease state are permitted.

Use disposable PostgreSQL, a private R=3 Kafka topic/group, ordinary authenticated
REST and SSE, production PiWorkerRuntime/Pi SDK, queue claim, SessionLeaseCoordinator,
Supervisor maintenance, management RPC and AssignmentReconciler. Only wiring and
a process-pause hook at the bus port are test-owned. Use paid DeepSeek Responses
through the existing Provider Gateway; keep all model bodies/credentials out of
the report. Cube is not needed for this pure-conversation boundary.

1. While the first model call runs, queue Follow-up and submit Steer by REST.
   Follow-up must remain queued; consumed Steer must precede Follow-up in native
   Session history; the next Run must start after the first Run settles.
2. Pause ingress before the first complete assistant mutation reaches Kafka.
   Follow-up must still be queued. Kill only the disposable Worker, wait for
   actual reconciliation, then start a new Worker to claim the queued Run.
3. After the replacement completes, resume ingress and inspect the late receipt,
   current branch, terminal states and the delivered-but-unconsumed Steer.
4. Record positive and negative assertions separately. A completed Steer delivery
   is not automatically a model-consumption guarantee. Do not redesign publication
   or input recovery until the observed behavior has been discussed.
