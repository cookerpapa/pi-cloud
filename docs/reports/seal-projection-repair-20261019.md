# Session seal projection repair and delivery

Decision: [ADR-0261](../adr/0261-session-seal-projection-boundaries.md).
Review baseline: `450a1efd`. Source: `0de1fe7fc7d8d3ec09e93e17d47df34730d02ab1`.
The maintained matched release `seal-projection-0de1fe7f` is deployed. Source,
artifact and all live gates except image cold recovery pass. The image repeat
remains unaccepted; final physical cleanup and configuration preservation are
confirmed. [Structured evidence](seal-projection-repair-20261019.json).
No schema or transport protocol version changes.

## Behavior

- Projection uses a Control Plane-owned direct-PG pool with 12 connections and
  30-second acquisition/checkout budgets, including cold boundary/replay reads
  and COMMIT response waits. SQL-local 2-second lock/10-second statement budgets
  remain. It reuses the existing checkout eviction adapter; ordered replay
  reconciles uncertain commits. API/publication/maintenance pools remain separate.
- Disposable native live views share the existing physical-Session writer
  incarnation. A confirmed duplicate closure prepares the same old-view cleanup
  as first closure. Cleanup runs after transaction success with generation and
  object checks. Historical old-writer replay cannot clear a newer writer's
  pending suffix. The same cleanup also covers already-closed normal completion.
- Latest native hash proofs use each document's existing replay lower bound
  and a backward Session/sequence lookup. Complete latest-value checks remain;
  no streaming body, checkpoint head or recovery authority is added to PG.
- Recovery reuses the initial locked Run and version through the existing
  transition helper. Trigger-enforced release ordering and transition CAS remain.

## Source verification

The focused run executes 109 tests. It initially passes 107: one new terminal
fixture omits mandatory failure fields, and one new fixture inherits Vitest's
default five-second timeout despite requiring a migrated private database.
Adding the required fixture fields and using the same 30-second fixture budget
as its siblings yields a nine-test passing focused repeat. No product behavior
or safety assertion is relaxed. Control Plane and native-storage typechecks pass.

The one-live-document closure uses **19 business statements plus one budget
statement**, with one locked Run read instead of two. Lost-return recovery retires
the cached live body while preserving the exact PG checkpoint. New-lease writes,
old prefix/seal replay, rollback, bounded cold/locked SQL and delayed cleanup are
covered. Native conformance includes independent replay starts and rejected
missing, old-sequence and changed-body proofs across interleaved Conversations.

The controlled query fixture keeps one pending document/change at history sizes
1 / 1,000 / 10,000 / 50,000. The repaired query returns one proof and examines one
matching header in every case. At 50,000 historical headers the local warm query
is 0.067 ms, compared with 16.742 ms and 50,002 matching headers in the recorded
review. These separate samples establish query shape/growth, not production
latency or fleet capacity. The complete checkpoint includes additional SQL.

Original defect assertions remain in the review commit. Maintained regressions
and the current query-cost probe replace them; no compatibility implementation
is retained.

## Full verification and matched release

A clean source checkout passes `npm run ci`: **1,937 workspace tests** across 22
packages, 11 environment skips, 79 acceptance helpers, nine real RF3/PG transport
tests and **323 fault cases in 95 groups**. The real transport gate runs the nine
Kafka cases separately from the ordinary workspace suite. Source policy, native
Cube/Helm, build, dependency and type checks also pass. Fresh fault evidence is
retained separately from the focused fixture corrections above.

The first artifact preparation stops on ten fixable HIGH curl/libcurl findings
in the cached Cube API image (`8.14.1-r2`). An uncached build of the same pinned
source/patches/base references installs Alpine's fixed `8.14.1-r3`; the binary,
size, provenance and patch checks still pass. The repeated maintained preparation
passes all **11 artifact scans** under the unchanged zero-fixable-HIGH/CRITICAL
policy. This does not claim that every raw, unfixed advisory is absent. See the
[Alpine package index](https://pkgs.alpinelinux.org/packages?branch=v3.21&name=curl).
The first failed candidate and its reports are retained privately.

Drained matched apply succeeds on the exact clean source revision. Schema 190,
execution-topic v17, boot reply v3, guest/Tool Worker 7, completion 3, preview 2
and Cube management 7 remain. The initial live check has 28 Ready Pods and HTTP
200. PG had 24 clients against a 100-connection limit before release; the new
projection pool adds a possible 12 connections. This is local operational
headroom, not a multi-host capacity result.

At the owner's request, the Docker daemon's persistent systemd drop-in changes
HTTP/HTTPS proxy from inactive loopback port 12450 to the already listening
10808. `NO_PROXY` is preserved. The initial restart caller times out while Docker
continues starting; eventual active state, effective proxy settings and a pinned
image pull are verified. K3s workloads remain Ready. The temporary build relay
is removed. Model traffic already uses 10808; provider/model credentials and
configuration are not changed by this host fix.

## Live acceptance

All gates use the maintained drivers and GPT-6 Luna on the same deployed source.
No timeout, prompt, image-size or recovery assertion is relaxed for the repeat.

- Native input consume/edit/Stop/Worker recovery passes. Lost intake replies retain
  retry identity, pending edits retain only current values, and one Run survives
  recovery. The same SSE connection accepts generation 1 → 2 activity. Streaming
  Stop and simultaneous Worker/Control Plane loss preserve the observed 159/134
  characters without retaining normal PG streaming bodies.
- Real-browser image draft removal/returned Stop input/direct vision and Read
  path aliases pass. The 120,017-byte ASCII and 140,031-byte Unicode files yield
  51,200/51,196-byte valid UTF-8 content with canonical truncation diagnostics.
- Native child handoff passes during compatible Control Plane replacement:
  13,590 ms replacement, unchanged artifacts/Worker, one Bash execution and the
  original control-Tool reply. Physical Workspace cleanup is confirmed.
- Complete Control Plane outage passes with **65,322 ms** actual absence and
  **7,921 ms** restore-to-Ready. Idle and busy Worker processes, active Session
  lease and VM remain unchanged. The next Tool intent is buffered in Kafka;
  the same-key new request succeeds after reconnect, and both Bash calls execute
  once in this fixture.
- Full Cube acceptance passes **20 model requests**: pure chat without VM
  activation, consecutive coding/preview/background reuse, persistent Volume,
  deleted-VM admission rejection, and a 1,024-file fixture restored to a fresh
  VM. The final conversation releases its runtime and native allocation closure
  is confirmed. The checked-in full-Cube report identifies this source revision.
- The fourth image attempt persists three source PNGs of 6,294,157 / 6,294,292 / 25,129,963
  bytes behind 596 / 596 / 597-byte native references; all three S3
  bodies match their hashes. The third Run then has repeated model no-header
  waits and reaches the unchanged 600-second fixture deadline. Normal cancellation
  and physical cleanup complete. **Cold Worker visual recall is not reached, so
  the image gate remains unaccepted.** The 120-second gateway wait includes
  upstream upload/processing before headers; these observations do not isolate
  proxy bandwidth, provider latency or another underlying cause.

## Retained failures and limits

The first image attempt reaches an upstream HTTP 500/TLS EOF after an initial
successful request. The second has a 120,198 ms no-header wait followed by 520
and 429 responses. After the owner's first confirmed proxy-node switch, two
approximately 6 MiB images complete, but the next Run makes four consecutive
120-second requests without response headers and fails. The failure occurs
before that Run generates the third image; it is not evidence that a 25 MB
image was rejected.

The first complete-outage attempt preserves renewal and receives the Cube result,
but an upstream 500/TLS EOF prevents generation of the next Tool intent. The
second buffers the next intent and admits the new request after restore, then
the old Run's final model request fails with another 500/TLS EOF. Both restore
the Control Plane and purge their owned fixtures. The first full-Cube attempt
fails on upstream TLS EOF during cold-VM continuation. These failed attempts are
not counted as passing infrastructure acceptance. After the owner's second
confirmed node switch, the unchanged full-Cube and complete-outage repeats pass.
The tests identify the observed provider failures, not a root-cause proof for
all upstream latency or network behavior.

Before the repeats, confirmed native absence permits removal of three orphaned
image objects, the failed full-Cube tenant and five recorded bootstrap projects/
Workspaces. Original account/configuration fingerprints still match, active
Runs/writers/routing/VMs are zero and all Pods are Ready. The final cleanup also
removes the latest image/full-Cube fixtures. Across both cleanups, six owned image objects are
removed. All seven original configuration fingerprints match (32 tenants/users/
API credentials, five password records, 35 model profiles/credential bindings,
zero SCM credentials). No test project, Workspace, Session, Run or image row
remains; native Volumes, node references, holds and open allocations are zero.
All 28 Pods and both Workers are Ready; WSL and Windows localhost return HTTP 200.

These one-host tests establish the listed recovery paths and query bounds, not
fleet capacity, arbitrary-shell exactly-once semantics or a latency SLO. The next
focused walkthrough remains replacement Worker → native Harness bootstrap.
