# Pending input pause after Stop — 2026-10-04

## Result

Chat Stop atomically pauses existing pending follow-up and Steer inputs while
requesting cancellation of the active Run. Text, attachments, frozen settings and
individual message identity remain intact. Newly sent messages execute without
resuming old input. Send resumes one paused message; Continue queue resumes the
paused backlog in its current order. Editing, removal and reordering remain
available. This implements [ADR-0222](../adr/0222-paused-inputs-after-stop.md).

PG remains the sole queue/admission authority. The existing Run intent has an
`input_paused` flag, and existing control receipts provide retry identity. Queue
changes use the existing Outbox/Kafka/SSE path. There is no new scheduler, browser
execution authority or per-Step database lookup. Resume assigns fresh tail
mailbox positions so earlier execution of new input does not corrupt history or
branch ordering. Moves stay within the paused or eligible group.

The Worker clears pending Pi queues through public `clearAllQueues()` before
`abort()`, matching TUI Esc. A regression test reproduced that abort alone could
consume queued Steer after a cancelled Tool returned. This fix leaves the durable
source available for reconciliation. Canonical consumption still wins races;
otherwise the target seal proves the message should return paused. No already
consumed instruction is recalled and no native Agent Loop is forked.

## Verification

| Gate | Evidence |
| --- | --- |
| Workspace regressions | 1,663 passing assertions across 22 workspaces after the corrected queue and final Supervisor reruns; nine external-service assertions skipped by default |
| Real PG queue | 32 tests passed, including new-input bypass, pause persistence, consumed/unconsumed Steer, resume across pages, stale/replayed commands and attachment/frozen-setting preservation |
| Worker Harness | 256 tests passed; the new native queue regression failed before the fix and passed after it |
| Helpers | 63 tests passed |
| Fault suite | [172/172](paused-inputs-faults-20261004.md), clean source `dd3897e5`; overlaps workspace assertions |
| Browser fixture | Edit, reorder, removal, promotion, reply loss, draft retention, stale reads, pagination, individual Send, Continue queue, viewer restrictions and mobile layout passed |
| Static/build | Workspace types, final Worker/Web types, documentation, runtime policy, matched image builds and server-validated Cube rendering passed |

The initial root `check` command had one failure in the newly added attachment
fixture: its JSON column was populated with a driver array rather than JSONB;
fixture cleanup masked the original error with a cancellation-lifecycle error.
The corrected complete queue file passed all 32 tests. The aggregate above uses
that rerun and the final 256-test Supervisor run instead of their earlier results;
it does not claim that the initial root command exited successfully.

## Matched release and real acceptance

[Machine-readable rollout evidence](paused-inputs-rollout-20261004.json) records
schema 173, application source `1e8c83e7`, Worker source `dd3897e5` and Web source
`b555f47b`. Apps use `paused-inputs-v1`, with Worker `paused-inputs-v2` and Web
`paused-inputs-v2-web`. Managed Cube protocol 5, Guest wire 3 and the existing
Guest template remain unchanged. The Cubelet completion wrapper was rebuilt
against matched protocol sources (`f30e189b09e7b51549ced7fe4e29ba5633cfe40b`).

Deployment checked quiescence before and after stopping admission, updated the
declarative Cubelet release, applied migration 173, and restored the platform.
No business data was reset. The native queue correction subsequently updated the
Worker image through the same Helm deployment path.

Real GPT-6 Luna/Cube/browser acceptance exercised five admitted Runs:

1. Start a long Bash, enqueue two follow-ups and a direct Steer, then Stop.
2. Verify all three unconsumed inputs remain paused; reload the browser.
3. Replace both Worker Pods after excluding unrelated pending/active work;
   verify none of the paused inputs starts.
4. Send a fresh message; retry the original Stop request and verify the fresh
   message completes while old inputs remain paused.
5. Edit and Send one paused message through the browser; verify the others remain
   paused. Continue queue, then verify replies and history in actual execution
   order: stopped Run, fresh input, individually sent input, remaining backlog.

The initial live fixture accessed the transcript before its first snapshot was
present. A missing-snapshot guard fixed the fixture; it cleaned up its owned
Session/Workspace, and the complete rerun passed. The final fixture also removed
its Session/Workspace. Post-acceptance inventory has zero pending/active Runs,
active leases, bindings or Cube VMs, and zero missing image references. Control
Plane, Web, both Workers and Cubelet are ready.

This live restart is graceful Pod replacement, not SIGKILL or multi-node HA
evidence. No exact attachment-inventory preservation claim is made. Subagent
input and VM lifecycle retain their existing authority and recovery contracts.
