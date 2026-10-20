# Upload and attachment lifecycle review

Status: review complete, fixes not implemented, 2026-10-20.
Baseline: `cf12b444`; runtime remains `model-runtime-058925bb`, schema 192.
Scope: browser upload identity/cancellation, API claims, Workspace/image placement,
native-input attachment binding, preview reads and object/staging cleanup.

## Findings

### UPL-01 · P2 · A definitely unaccepted native input can permanently pin its uploads

For an active Run, `QueuedInputService.accept()` calls `bindInputUploads()` in the
PG intake transaction. That helper irreversibly sets `accepted_at`; the Worker
grant lookup and input RPC happen afterwards. `mutate()` similarly binds edited
attachments before the native mutation. There is no rollback/reconciliation of
this marker when no native input was accepted.

The real-PG probe has a valid receiving Run and refuses backend acquisition before
any command can be sent. Input acceptance fails, but `accepted_at` remains set.
Explicit draft removal then does nothing, and expired draft/object cleanup leaves
the upload and image pinned. This is distinct from a lost acknowledgement of a
possibly committed native input.

Sources: [`queued-input-service.ts`](../../packages/control-plane/src/queued-input-service.ts)
and [`workspace-upload-service.ts`](../../packages/control-plane/src/workspace-upload-service.ts).
Direction: distinguish provisional reachability from confirmed input acceptance,
and reconcile known refusal and uncertain delivery against the existing native
input identity. Do not simply unpin every failed HTTP request: another input may
use the upload, or the native commit may have succeeded. Retention of attachments
that really were accepted and later cancelled is the existing explicit policy,
not the defect claimed here.

### UPL-02 · P2 · GC can forget an old in-flight image PUT before its late completion

An upload can legitimately progress beyond the 24-hour object cleanup grace.
Its live upload row normally protects the image inventory. Removing the draft
deletes that row immediately; server-side upload cancellation is only noticed by
the claim-renewal path or disconnected request. The object reaper can then mark
and delete the old uploading inventory/object before the PUT finishes.

The probe ages the object to two days while leaving its upload claim current,
holds the final PUT, removes the draft and runs the normal reaper. One inventory
row is deleted. Releasing the PUT creates the object; the later inventory-ready
update fails, so the API correctly rejects the upload, but the blob has no PG
inventory and a second reap finds nothing. The controlled blob store checks its
AbortSignal: the signal has not yet been cancelled. The result does not depend
on a writer ignoring an abort.

Sources: [`WorkspaceUploadService.remove()`](../../packages/control-plane/src/workspace-upload-service.ts)
and [`PostgresImageAttachmentStore.putStream/reap()`](../../packages/session-attachments/src/store.ts).
This is an orphan-object leak, not evidence of an incorrectly accepted upload or
lost committed attachment. It is a narrow long-upload/cancellation boundary; the
review does not claim ordinary short uploads currently leak this way.

Direction: retain a recoverable cleanup identity across an unfinished/uncertain
write, and base reclamation eligibility on its lifetime rather than original
creation age alone. Reuse existing upload/inventory state where possible. Keep
both placement branches joined on failure and protect accepted/shared references.

### UPL-03 · P2 · Cancelling an image-preview request does not cancel its source read

`readInputImage()` calls `WorkspaceUploadService.image()` and then `images.get()`
without the browser request's cancellation signal. A disconnected browser does
not release the S3 read/capacity wait; it can continue until completion or the
image store's own 60-second deadline.

A loopback HTTP probe authenticates and begins an actual API request, waits until
the controlled blob read starts, then closes the client request. The blob signal
remains unaborted and its read remains pending. The fixture explicitly releases
that read during cleanup. This proves missing cancellation propagation, not an
unbounded production socket leak or an actual S3 outage.

Sources: [`control-plane.controller.ts`](../../packages/control-plane/src/control-plane.controller.ts)
and the upload service/image store above. Direction: pass caller cancellation
through metadata/capacity/blob operations and join response/source teardown.

### UPL-04 · P3 · Early upload refusal leaves a started source iterator unclosed

`sniffUpload()` starts consuming the verified source before MIME/claim validation.
Unsupported-image and other early refusal paths occur outside the main transfer's
cleanup. The returned chunks generator has not started, so its `finally` cannot
close the original iterator.

The direct service probe uses a generator with a cleanup flag. Unsupported GIF
input is rejected after reading its prefix, but the flag remains false until the
fixture explicitly closes the source. This is an iterator ownership gap; no claim
is made that Fastify necessarily leaves every underlying HTTP socket open forever.

Direction: make the started source's disposal available and invoke it on every
exit, including pre-transfer refusal. Do not drain an arbitrary rejected file just
to reach EOF or release a filesystem writer before its callback has settled.

## Simplification and retained design

**UPL-O1:** original-image preview downloads currently assemble a full Buffer in
Control Plane before sending it. Upload transfer and model-image preparation are
already streamed; this remaining preview path is distinct. Consider the existing
attachment `withStream` port for forwarding, coupled to UPL-03's cancellation and
complete-source/error semantics. Large original files need not add another full
Control Plane buffer. No large-image OOM test or throughput benefit is claimed.

The following remain appropriate:

- HTTP carries upload bytes with length/hash verification and backpressure; Kafka
  and queue records carry only references and bounded metadata.
- Workspace files and immutable Session image sources have distinct owners and
  lifetimes. Removing a draft does not delete ordinary Workspace files.
- Native input/image pinning must protect the commit/projection gap, including
  lost acknowledgements. Source-image normalization stays in Cube.
- Unique same-filesystem staging plus non-replacing publication preserves retries
  and user changes. OS-held locks and filesystem recovery locators let cleanup
  distinguish active uploads from abandoned temporaries.
- Existing branch failure handling aborts and joins both Workspace and S3 placement
  before ending its claim. GC rechecks references after taking inventory locks.

## Evidence and limits

64 existing tests in ten files pass: upload API/native input, streamed bodies,
S3 transport, image storage/reaper/codec, file/staging placement and browser digest.
Four new characterizations pass by reproducing the unchanged baseline defects.
They use current migrations and real PG; one uses the actual loopback API and
client disconnect. Blob/Workspace effects are controlled stores, not production
S3 or Cube. The long-upload case ages inventory instead of running for two days.

Initial probe configuration omitted Nest's decorator setting, used the wrong
upload-module import and typed an attachment-owned table through the domain DB
interface. Those harness issues were corrected. The generic native-control
fixture also needed a multimodal Run descriptor and a claimed Session state to
reach the intended input-delivery boundary; the earlier validation/lease failures
are not production findings. Final probes typecheck and reproduce all four cases.

No production code/configuration, live models, existing objects or VMs changed.
All test sources, outstanding reads/writes and temporary databases are closed by
the fixture. Previously verified live image/queue gates are not relabelled as new
live tests here.

Reproduction commands:
[`scripts/experiments/review-upload-20261020/`](../../scripts/experiments/review-upload-20261020/README.md).
Aggregate evidence: [JSON](upload-lifecycle-review-20261020.json).
Raw private logs: `deploy/production/runtime/review-evidence/upload-20261020/`.
