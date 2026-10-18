# Projector/browser repair delivery

Date: 2026-10-18. Approved plan:
[ADR-0257](../adr/0257-browser-observation-and-buffer-boundaries.md).
Implementation baseline: `a57e46ee`. B1–B3 are implemented in source; full
verification, artifact scans and matched/live rollout remain pending.
Serving release remains `session-completion-6e74fd5b` until deployment is recorded.

## Source behavior

- Activity/path/execution frames require the existing Session fencing generation.
  Projector uses its admitted scope, with no added SQL/counter. Server and browser
  reset the entire observation bundle on a newer generation and reject older
  frames. Pending observations cannot replace newer generations with older types.
  Same-generation TTL/capacity eviction resyncs its Session readers.
- Browser observation state is a pure module separate from its React renderer.
  The real server/SSE/parser/store integration can test root and child recovery
  without importing a browser-rendering runtime into the backend. There is no
  compatibility re-export or optional-generation decoder.
- Pending formal delivery has both 1,024-event and 16 MiB encoded-byte guards.
  Measurement is lazy, once per broadcast needing queuing; direct waiting readers
  and absent subscribers need no counting. Queues retain event references and
  byte counts, not additional serialized bodies. Dequeue/reset/overflow/close
  release accounting; overflow clears disposable channels and uses existing
  replacement-snapshot recovery. In-flight values and large snapshots retain
  their normal framed delivery.
- Same-message, same-phase commentary appends compact in the recovery cache.
  Original live events, message identities, replacements, canonical renaming,
  gaps and distinct commentary messages retain their boundaries. Obsolete public
  25 ms buffering descriptions are removed from maintained guidance.
- The native-input recovery driver now holds one real SSE connection through its
  owned Worker crash and checks the browser parser/store accepts newer-generation
  activity and confirmed Cube evidence. A recovery follow-up waits 35 seconds in
  Bash so the normal bounded path probe can be observed. Other native-input,
  streaming Stop and dual-process crash assertions remain.

## Verification progress

51 focused tests pass, including actual server/SSE/browser-store handoff for root
and child views, late-old rejection, same-generation expiry, pending-byte release,
periodically draining sockets, healthy-reader isolation, large replacement
snapshots and commentary identity/coverage. Scoped runtime-core and web-ui
typechecks pass. Six maintained fault cases are added (294 total expected).
The real-browser presentation gate passes, including rendering a new generation
and ignoring a later old-generation activity frame. A bounded queued-broadcast
micro-sample measures 256 KiB events at about 0.60 ms median with either one or
four viewers; small-event medians are below 0.02 ms. This is local counting/fanout
cost, not network throughput, fleet capacity or an end-to-end latency claim.

Initial local checks caught a test-helper closing brace and cross-package test
type dependencies. The helper is corrected; the browser store is separated from
its React renderer and the integrated test lives with runtime-core. These do not
change browser JavaScript compatibility settings or execution semantics.

Full CI, real-browser presentation, artifact scans, matched deployment and live
outcomes will be recorded here after completion. The old defect characterizations
are archived at `8cd04fda`; maintained desired-behavior regressions replace them.

## Release boundary

The public observation shape changes together across Control Plane and Web;
open browser pages reload at deployment. PG schema 189, execution topic v17,
reply v3, guest/Tool protocol 7, completion startup 3, preview 2 and Cube management
7 remain unchanged. Use the maintained scanned/drained matched operator and
preserve accounts, model/provider configuration and credentials. Only owned
fixtures may be removed, after positive physical cleanup.
