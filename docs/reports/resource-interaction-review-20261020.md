# Resource and interaction branch review

Status: all four agreed review slices complete, 2026-10-20.
Runtime fixes are not implemented by this review. Serving source remains
`058925bb2036e8ea9dd8f906c631961b0fee1787` (`model-runtime-058925bb`, schema 192).
Approval functionality remains deferred.

Follow-up: the [repair plan](resource-interaction-repair-plan-20261020.md) now
incorporates the owner's mailbox/idempotency discussion and verified Pi 1.0
foreground/background examples. ADR-0264 is proposed for direct-delegation
continuation and discovery; the findings below remain unrepaired baseline evidence.

## Assessment

The findings do not justify replacing PG, Kafka, native Pi Durable or Cube.
The main architectural weakness in these branches is inconsistent ownership
and lifetime handling at boundaries that changed during migration: shared VMs,
native child Conversations, current Inbox state and pending connections.

Examples are concrete. A root Run no longer identifies all child compute users,
but orphan cleanup still consults that old-shaped relationship. Terminal-held
compute is missing from one recovery view. Reading a pending supervisor request
causes a new reconciliation wake even when no fact changed. A native-input
attachment is marked accepted before native acceptance. Connection shutdown
sees established sockets but misses ones still opening.

These are incomplete applications of the current architecture, rather than a
reason to add another scheduler, result ledger or cache. Each repair should name
the existing authority, the live owner and the event that ends its responsibility.
Derive disposable views from that authority; do not make a view a second owner.

## Confirmed findings

| Priority | ID | Observable effect | Proposed repair boundary |
| --- | --- | --- | --- |
| P1 | WVL-01 | Orphan cleanup can select compute still used by a human terminal or native child under a valid root lease | Existing PG holder/admission query, current Session-family associations |
| P1 | WVL-02 | A terminal-only VM is adopted again into the warm pool and can be expired while in use | One local runtime identity and complete holder accounting |
| P1 | SAR-01 | An unchanged supervisor question wakes itself repeatedly; the probe executes 20 times/63 SQL in 76 ms | Existing Controller/Dispatcher change and deadline notifications |
| P2 | WVL-03 | Unknown Cube Volume refs do not converge after recovery, blocking safe reuse/cleanup | Native versioned ref recovery with retained physical identity |
| P2 | WVL-04 | Run and terminal admission take Session/Workspace locks in opposite order, causing a bounded refusal | Consistent PG lock order, retaining deletion exclusion |
| P2 | SAR-02 | New progress can hide an older unanswered decision from the parent | Distinguish progress from pending questions in current reads |
| P2 | SAR-03 | A cancelled child can still be presented as waiting for a supervisor answer | Native terminal state takes precedence in interaction reads |
| P2 | SAR-04 | Disposed workflow results remain reachable until the entire Run's bindings are released | Cache belongs to the owning workflow Tool lifetime |
| P2 | UPL-01 | A definitely unsent native input permanently pins its draft images | Provisional versus confirmed acceptance using existing input identity |
| P2 | UPL-02 | A long in-flight image PUT can complete after GC forgets its inventory | Cleanup identity survives unfinished/uncertain writes |
| P2 | UPL-03 | Cancelling an image preview leaves its source read running until completion/deadline | Caller cancellation through the existing attachment read port |
| P2 | TPR-01 | A legitimate terminal owner redirect closes the browser before connecting the new owner | Redirect state established before asynchronous validation |
| P2 | TPR-02 | A stalled terminal upstream handshake leaves the UI starting indefinitely without its own deadline | Connection-establishment deadline, independent of active work |
| P2 | TPR-03 | Closing a preview does not cancel its pending internal CONNECT | One lifetime for caller, pending request and late socket |
| P2 | TPR-04 | A preview can finish opening during shutdown, escaping its cleanup pass | Track pending opens and reject/dispose late establishment |
| P3 | UPL-04 | Early upload rejection leaves an already started source iterator unclosed | Close the consumed source on every refusal path |

There are 16 findings: three P1, twelve P2 and one P3. The two shared-VM findings
have separate causes; repairing the orphan query alone does not repair duplicate
warm adoption. WVL-03 expands the previously known Cubelet recovery backlog item,
not a claim of a new unreclaimed production Volume.

## Design discussion and simplification

**Direct child discovery after interrupted launch (SAR-D1).** The model may know
it issued a launch without having received the returned child ID. Same-command
idempotency works, but the public Tool has no family list and its status API
does not accept the original provider/native task ID. Consider a small read-only
family directory or recovery summary built from existing identities. Do not
deduplicate distinct model calls by prompt similarity or replay unsafe Tools.

The measured SQL opportunities are bounded: empty Workspace deletion uses 13
business statements, including five independent occupancy reads; revisiting an
already acknowledged pending child uses seven, including two locked reads.
Combine compatible reads or reuse confirmed identity under the existing
authority. The measurements alone do not justify a new cache.

Other cleanup candidates are the unused resource-policy `turnWallClockTimeoutMs`
field, original-image preview buffering despite an existing streaming port, and
Subagent documentation describing pre-migration limits/ownership. The unused
field is not an active Run limit. Actual no-overall-Run-limit behavior remains.

## Suggested repair order and acceptance

1. Fix WVL-01/02 and SAR-01 first. A terminal/native child must prevent retirement
   of its VM; local recovery must not create a second idle owner; an unchanged
   question must produce no self-triggered work. Retain explicit deletion and
   expiry semantics, with no VM destruction based on missing heartbeats.
2. Finish Volume recovery evidence and admission lock order. Test last-holder,
   shared-holder, delayed creation/attach and node-restart cases. Unknown state
   can clear only with positive evidence. A changed recovery protocol needs an
   ADR before implementation.
3. Repair child question/terminal-state precedence and workflow cache disposal;
   decide SAR-D1 before implementing new public discovery behavior. Test parent
   interruption before a launch reply as well as ordinary same-call retries.
4. Repair attachment acceptance and source/write lifetimes. Distinguish proven
   non-delivery from lost acknowledgements; preserve other accepted references.
   Test cancellation during both Workspace and object placement, including a
   late write after a long transfer.
5. Repair terminal/preview establishment and shutdown. Use deterministic redirect,
   browser-close and shutdown barriers, then verify live terminal reconnect and
   preview HTTP/SSE/WebSocket on a compatible Control Plane replacement.
   Do not replay input or treat transport closure as VM/process-death evidence.

These are separate vertical repair slices, not authorization to implement a
large replacement architecture. This review itself changes no runtime behavior.

## Evidence

| Slice | Existing checks executed | New evidence | Detailed report |
| --- | --- | --- | --- |
| Workspace/Volume | 205 Node cases; maintained Cube allocation/reference contracts | 7 real-PG characterizations/measurements; 3 native ref scenarios | [Workspace/Volume](workspace-volume-lifecycle-review-20261020.md) |
| Subagent | 64 Node cases | 5 real-PG characterizations/measurements; 1 explicit-GC reachability probe | [Subagent](subagent-lifecycle-review-20261020.md) |
| Upload/attachment | 64 Node cases | 4 PG/HTTP/source-lifetime characterizations | [Upload](upload-lifecycle-review-20261020.md) |
| Terminal/preview | 70 Node cases | 4 owned loopback transport characterizations | [Terminal/preview](terminal-preview-review-20261020.md) |

Counts describe executions by slice and may overlap. Passing characterizations
mean the reported baseline behavior was reproduced; they do not mean it is fixed.
The native ref scenarios use the pinned Cube source/patch set and race detector.
New VM destruction is represented by a controlled provider callback; no real
user VM was destroyed. Blob writes and some DB/backend boundaries are controlled
ports, identified in the individual reports. No new paid model calls, production
state changes or deployment occurred.

The agreed branch review is complete, alongside the previously completed
main-message walkthrough. This does not establish zero defects, large-scale
capacity or transparent continuity of every interactive connection. Existing
work on a compatible Control Plane replacement procedure and long-lived Worker
registration renewal remains distinct. Future repair acceptance should include
the relevant live paths after source/contract checks pass.
