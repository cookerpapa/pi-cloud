# Preparation timings and manual reading

Matched `timing-reader-20261031` is deployed from
`6811faf976543fa2ea679a9d7d2ec156295798de`, on schema 206 and platform Helm revision
133. Source checks, real-model diagnostics, native recovery and deployed browser
streaming acceptance passed. All owned acceptance resources were purged.

## Reading behavior

The reported sequence was reproduced in an actual browser: collapse Tool groups,
manually expand a large group, then scroll or select text. The old behavior moved
the expanded group by 5,414 pixels toward its tail. Streaming text could clear the
selection, and virtual row recycling could remove its origin.

Manual disclosure and upward gestures now suspend end following and cancel any
pending virtualizer scroll. A bounded reading window retains its content and
anchor. Already visible Tools still receive their final results unless a native
selection is active. Selection pins the selected DOM band through TanStack's
public range extractor, pauses pagination and text animation, and releases pins
when cleared. Nested code scrolling does not resume outer end following.

Returning to latest displays buffered text immediately; new text then resumes
normal streaming. No transcript or server-side execution behavior changes.
The existing bounded reader remains the history authority in the browser; this
does not load lifetime history to preserve a selection.

The final browser fixture measured zero movement both on disclosure and on Tool
settlement. A 12-pixel upward wheel gesture retained reading mode. Native text
selection survived appends and 2,600 pixels of scrolling; code selection survived
1,200 pixels of nested scrolling, then released back to 32 mounted lines.

## Diagnostic behavior

Existing public Harness, Models and Storage boundaries emit one bounded timing
record per stage. Startup, native context/request preparation, image hydration,
cloud admission, SDK-to-fetch preparation and Gateway body handling are distinct.
Read observers aggregate actual work without additional PG/S3 reads or payload
copies. Sink failure cannot replace the original return value, error or cancellation.

Records go to rotating container stdout logs and existing metrics, never native
history, Kafka or PG. No per-token or per-image logging is added. Public Pi task
phases and existing fetch/payload hooks retain their original calls and values;
Pi core, ownership and provider retry behavior remain unchanged.
See [stage definitions and interpretation](../OBSERVABILITY.md#worker-startup-and-request-preparation).
Nested and parallel read timings overlap and must not be added as independent
parts of total latency.

The owned two-Run image check produced 36 scoped timing records. Its two input
acknowledgements took about 61 and 37 ms. In this small fixture, writer preparation
took 548/537 ms; native context preparation took 21/54 ms; SDK-to-fetch preparation
took 12/6 ms. The first input's preparation, which included placing its uploaded
image into the Workspace, took 2.37 seconds. The second cold owner reported image
hydration in its native read phases. These are diagnostic examples, not estimates
for the original large conversation or a throughput benchmark.

A 10,000-stage microbenchmark, after 1,000 warmups, measured about 43 microseconds
incremental cost and 537 bytes per record with real JSON, metrics and a drained
stdout pipe. It excludes the container collector and filesystem persistence.

## Verification

- Relevant Observability, attachment, Session Storage, Sandbox supervisor and
  trusted Worker suites passed 561 tests; Web passed 222 tests. Relevant package
  typechecks, documentation, formatting and observability checks passed.
- Two LISTEN recovery tests initially failed because their real host-memory
  monitor stopped queue scanning under memory pressure. Their fixture now injects
  available headroom; focused and full Worker rechecks passed. The production
  memory monitor is unchanged; the original failure log is retained.
- Browser geometry, native selection, Tool settlement and complete presentation
  checks passed. The actual API/SSE/Web history check used 1,073,973,615 logical
  bytes and 49,845 records. Its browsing sample retained four pages, 14 mounted
  rows and roughly 16.5 MB of JavaScript heap.
- Matched provenance, build closure and the maintained 12-image release scans
  passed. No guest template change was required.
- Real Luna/image timing acceptance completed both Runs and confirmed storage
  reads, cold image hydration, SDK fetch and Gateway timing records without prompt
  or credential attributes.
- Native acceptance passed consumption, Stop, Worker crash, streaming Stop and
  simultaneous Worker/Control Plane crash. Single-Run and retry identity held;
  partial output survived and transient streaming bodies were not retained in PG.
- The deployed Web completed three actual Bash calls and intermediate/final text.
  Across 947 sampled frames, the longest geometry mismatch lasted 15.6 ms;
  final gap was zero and the reader remained at the latest edge.

## Publication and preservation

Before cutover, an already settled Run retained a closed Sandbox binding. Its
old controller rejected cleanup because its locally confirmed ownership lease
had expired. With no active Run or writer, a routine Control Plane restart let
existing ownership recovery retire the binding without changing either VM
allocation. The readiness/diagnostic gap is recorded in the backlog; no ownership
rows were manually discarded and no fencing check was removed.

The matched upgrade then closed the old allocations under quiescence and confirmed
physical absence while retaining Volumes and desired running state. Both machines
recovered, at generations 35 and 5. Original applications on ports 4189, 4190 and
8000 restarted from the fresh process inventory and served matching HTML.

Before application restart, strict hashes matched all 5,998 Workspace files,
14 protected database tables and 27 configuration/credential files. All 150
retained images matched. After live acceptance, protected records, credentials,
images and application content still matched; file changes were limited to the
three application logs and the already-running application's refreshed snapshot.
Both recovered allocations survived the later fault checks. All 29 serving Pods
were Ready, with no active Run, writer, Tool binding or elastic fixture remaining.

Private evidence lives under
`deploy/production/runtime/work-evidence/preparation-timing-20261031/` and
`deploy/production/runtime/release-evidence/timing-reader-20261031/`.
No original conversation was resubmitted or compacted. The deferred 131 MiB
cold-image experiment was not reopened.
