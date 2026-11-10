# PiCloud deterministic fault evaluation

Generated: 2026-11-10T20:36:09.087Z

Revision: 292e558869fab364c7c0152afc828a42b16bbb47

Uncommitted changes at test start: yes

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 20
- File-group executions: 8; total wall time: 74940 ms
- Case durations are Vitest assertion durations, not independent process startup times.
- Invariants preserved: 20/20 (100.0%)
- p50 / p95: 25 ms / 7678 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| native-creation-permit-recovery | pass | Owner replacement never reissues an uncertain native create. | 7678 ms |
| native-creation-unissued-close | pass | Known unsent admission closes without fabricating a native effect. | 7762 ms |
| native-creation-receipt-after-close | pass | One sender is admitted; a factual late receipt cannot reopen resource admission. | 7603 ms |
| native-creation-no-http-retry | pass | A disconnected native creation reply triggers no second POST. | 5 ms |
| native-timeout-renewal-wire | pass | Elastic renewal uses the provider-native timeout contract, not a private allocation journal API. | 25 ms |
| guest-cold-connection-from-cloud-capsule | pass | Cold Guest-control access uses retained private connection data and never calls a managed allocation receipt or implicitly resumes compute. | 25 ms |
| native-creation-metadata-recovery | pass | Read-only unique native lookup recovers the original VM. | 3 ms |
| native-creation-ambiguous-lookup | pass | Missing or duplicate physical identities remain unresolved. | 2 ms |
| native-creation-receipt-failure | pass | Lost receipt ownership stops Guest initialization without unowned physical cleanup. | 1 ms |
| native-timeout-stale-activity | pass | Delayed activity does not receive a new full retention window and expired activity never renews compute. | 14 ms |
| native-recovery-refusal-not-absence | pass | A recovery-time local refusal cannot disprove the first request effects. | 7 ms |
| native-missing-inventory-not-absence | pass | Only positive retained provider evidence can establish deletion. | 5 ms |
| native-lifecycle-source-outage | pass | Unavailable lifecycle evidence does not release resources. | 2 ms |
| native-lifecycle-history-gap | pass | Provider history gaps remain explicit. | 1 ms |
| native-observation-unpriced | pass | Best-effort samples never invent confirmed monetary amounts. | 6348 ms |
| native-observation-empty-page-cursor | pass | Empty observation pages retain atomic cursor fencing. | 410 ms |
| machine-unresolved-create-admission | pass | Concurrent API owners cannot admit a second unresolved machine for the same user; exact retries and independent users retain their own identities. | 394 ms |
| machine-recovery-retains-occupancy | pass | Sealing a lost Worker does not release the original logical Run's resource occupancy. | 151 ms |
| workspace-recovery-retains-occupancy | pass | Recovery-pending work cannot lose its Workspace even when the old writer was sealed. | 127 ms |
| workspace-stop-seal-retains-occupancy | pass | A user Stop with unfinished ordered writer closure still blocks resource deletion. | 73 ms |
