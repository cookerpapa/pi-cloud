# ADR-0266: Attachment pins and unfinished object writes

Status: accepted implementation decision under the owner-approved resource repair
plan, 2026-10-20. Source regressions pass; matched live acceptance pending.

## Authority and evidence

Pi owns additional input and edit receipts. PG upload metadata owns reachability;
S3 owns image bytes. Workspace files remain ordinary Volume files. Do not add a
second pending-input queue, object broker or transcript copy.

Reviewed the adopted AWS SDK/S3 APIs:
[PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html),
[conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
and [multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html).
A successful PUT confirms complete storage. Losing a response does not prove
failure. HEAD/DELETE cannot revoke an earlier ordinary PUT; multipart completion
would introduce a different lifecycle requiring additional receipts and cleanup.
Retain the existing SDK/streaming port and add bounded metadata bookkeeping.
Do not invent a time after which all remote writes must have finished.

## Input reachability

Initial Run admission still binds attachments in its PG transaction. Additional
input/edit admission instead creates provisional upload pins before delivery,
each bound to the exact delivery token, native operation/fingerprint, Run,
Conversation and Session lease. Pins contain references only, never input text.
Validation failure rolls back admission. Failure before contacting the Worker
or an explicit native refusal releases only that delivery's pins.

Native acknowledgement promotes those pins to confirmed upload retention.
An ambiguous response leaves them intact. The existing maintenance pass
reconciles bounded pin groups against current native input/edit receipts. A
matching receipt confirms acceptance even after edit/withdrawal. An absent
receipt permits release only after that exact old writer's ordered seal has
materialized. Missing projection progress alone proves nothing. Concurrent
deliveries using the same upload cannot release each other's pins.
For submit, the preparation metadata/fingerprint is insufficient: also require
the original indexed native Submission. Image preparation may fail after metadata
commits but before any input reaches Pi's Inbox. Edit receipts are written with
their native queue mutation and already prove that mutation.

## Byte writer and cleanup lifetimes

Inventory persists before PUT. Record positive write completion after the
storage port returns success, even if the caller has since cancelled. A known
failure before sending also ends the writer obligation. A transport error or
process crash without positive completion leaves the obligation uncertain.
The S3 port performs one attempt per call: an automatic retry cannot leave an
older same-key PUT running behind an acknowledged newer attempt.
If that attempt stops before receiving the complete declared request body, S3's
no-partial-object contract proves failure; record writer completion while keeping
the upload unpublishable. A complete body without a receipt stays uncertain.

Draft removal signals cancellation to its local uploader and joins known local
work. It does not erase image inventory. GC may repeatedly delete an unreachable
uncertain object, retaining its small inventory/cleanup marker and deferring the
next sweep. It removes inventory only after positive writer completion plus
successful deletion. Thus a late PUT never produces an untracked blob.
Fixture account cleanup obeys the same writer-completion prerequisite.
Completion must be known before issuing that DELETE. If it becomes known during
the delete request, another cleanup pass is required before forgetting inventory.

An uncertain crashed PUT may retain a marker indefinitely; this is explicit
unfinished cleanup evidence, not a retained image or a successful deletion claim.
It can be retired only with provider-specific writer quiescence evidence.
The existing maintenance timer/backoff handles these rows; there is no second
scheduler. Active progressing upload claims do not expire solely by object age.

## Cancellation and preview streaming

Own the original started iterator from MIME sniffing through all validation and
transfer paths. Early refusal must close it even if its wrapper generator was
never entered. Propagate browser cancellation through metadata reads, capacity
waits and object reads.

Original-image previews use the existing scoped streaming source. Hold the last
chunk until length/hash verification so a corrupt source cannot deliver a
successful full Content-Length response before validation. Join HTTP/source
teardown and preserve backpressure, without another complete image buffer.

## Verification and cutover

Test definite no-send, ambiguous ACK, concurrent reuse, edits/withdrawal and API
restart/old-writer closure. Test late successful PUT after draft removal, uncertain
crashed writers, GC retry fairness, early MIME/claim rejection, cancellation at
placement/read boundaries and late integrity failure. Live acceptance must use
actual Cube/S3 upload, input/Stop/image recall and interrupted preview requests.
Schema changes ship with matching code after writer draining; obsolete business
history may be removed while accounts, configuration and credentials remain.
