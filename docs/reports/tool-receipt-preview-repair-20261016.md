# Tool receipt and preview repair

Baseline: `39ec5643`. The owner approved [ADR-0252](../adr/0252-tool-receipt-and-ephemeral-preview.md).
Status: implementation in progress; serving release remains `guest-execution-5536fc73`.

## Acceptance and progress

- [x] Source: receipt-only failure preserves valid completed outcomes and background-work admission;
      missing proof, real timeout/fault cleanup and native abort remain distinct.
- [x] Source: guest renders bounded terminal-aware previews independently of final output.
- [x] Source: revision-bound edits/resets survive tested lossy/coalescing boundaries without
      entering Kafka, PG or model context; final completion retires observations.
- [ ] Required source/native/race/transport/fault checks and artifact scans pass.
- [ ] Matched release and real Luna/Cube/browser/failure acceptance pass, with
      preserved configuration and confirmed fixture cleanup.

Failed samples, release identity, verification counts and measured limitations
will be recorded here as work proceeds. A checked source slice is not a deployed contract.

R1 source checks: 13 targeted guest tests, Tool Sandbox typecheck and the full
patched native execution suite with the race detector pass. A real local PTY
running the actual launcher/guest (privilege and cgroup operations substituted)
retains a successful final frame and exits 76 on a withheld receipt, without a
plain protocol error; the healthy case exits 0. Native FIFO tests cover preserved
receipt-only results, required timeout cleanup, wrong identity, duplicate/partial
frames and deadline/result races. Live VM/background preservation is still pending.
R2/R3 targeted suites pass 113 tests before the added real-HTTP and launcher
contracts. The HTTP→subscription→browser-store chain passes with a 6,338-byte
initial preview and a 557-byte coalesced edit in its synthetic sample, including
missing bases, HTTP failure, owner redirect and a new subscriber. Actual launcher
PTY contracts pass normal/missing/malformed receipt and reserved-child-exit cases.
The unchanged-screen test now varies the source fixture's final counter when
asserting repeated observations: identical terminal views intentionally emit no
delta. Typechecks pass across the workspace. Complete CI and live acceptance remain pending.

The stop-helper race is also covered: an empty proof observed before its deadline
can retain a receipt-only exit just after that deadline, using a short join within
the existing final cleanup budget. The full updated native suite passes with the
race detector (23.2 seconds in the isolated sample).

A fresh Node synthetic source sample processes 20 paced display states in 55 ms
wall / 58 ms CPU, emits 16 deltas and four resets totaling 8,423 update bytes, and
observes about 5.3 MB incremental peak heap. The largest update is 1,759 bytes;
this particular sample uses short lines. A separate injected oversized input
retires its preview while the independent final collector retains `FLOOD_DONE`.
These are bounded local samples, not fleet capacity or live VM acceptance.

The first complete CI invocation passed native/allocation, Helm/installer and
build gates, then caught a new test importing a React `.tsx` module into a backend
package without JSX enabled. The browser's pure preview store is now a separate
module shared by the renderer and chain test. This was a test dependency issue;
the failed sample is retained, and affected build/check stages plus remaining CI
gates must pass before preparation.
