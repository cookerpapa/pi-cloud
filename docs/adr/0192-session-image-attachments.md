# ADR-0192: Immutable Session image attachments

Status: accepted, implementation and acceptance in progress (2026-09-26).

## Problem and decision

The owner approved separating image bytes from Kafka for repeated frontend
screenshots. The previous inline native-result path had incompatible 2 MiB file,
5 MiB reply, approximately 1 MiB execution-log and 8 MiB model-request limits.
Increasing one limit or replacing only the Tool reply hop does not fix history.

Keep the fixed Pi Tools in Cube and the Agent/Harness in the trusted Worker.
Transfer guest results over the existing bounded Cube HTTP stream. At the trusted
Broker boundary, persist image content through a PiCloud-owned S3 attachment port
and replace only image content parts with versioned references in Kafka replies.
The owning Worker's callback fetches and verifies the bytes and gives Pi ordinary
ImageContent. Pi's after-hooks still decide the canonical result. Native Session
append encoding externalizes that final result too; cold SessionStorage reads
decode references back to the exact native content. Pi's loop is unchanged.

Kafka and PG native-log payloads contain text and attachment references, not
image Base64. This explicitly amends ADR-0161's self-contained inline byte
representation and ADR-0183's Tool reply encoding. Entry/Record identity, order,
writer stamps and acknowledgements remain unchanged. PG plus its retained
attachments constitute the lossless native log. Tool replies remain boot-local
transport, not canonical history. No Tool-result GET/cache, operation ledger or
automatic effect replay returns.

Only native image content is externalized. Pi's opaque `details`, Tool arguments,
custom `data` and resume data remain ordinary JSON with the existing record-size
bound. The retention walker follows that same boundary. Fixed guest Tools may
return at most one image from `read`; arbitrary image-shaped workflow return
objects do not trigger uploads. Two read transfers and a bounded admission wait
protect Broker memory; HTTP chunks are joined once per completed frame.

Cube Volume remains the editable Workspace authority. An attachment is an
immutable copy of an image actually returned to the Session, not a Workspace
backup/checkpoint. Overwriting or deleting the source cannot alter history.

## Adopt-before-build evidence

The required storage operations are durable PUT, authenticated bounded GET and
idempotent DELETE. Use the maintained AWS S3 SDK behind a small owned port, not a
home-built file server, signing protocol, Kafka chunk assembler or storage engine.

- [Ceph RGW](https://docs.ceph.com/en/latest/radosgw/s3/) is a mature foundation-
  backed S3 implementation. Existing Ceph installations fit the port, but deploying
  its cluster solely for this one-host image workload has excessive operating cost.
- [SeaweedFS](https://github.com/seaweedfs/seaweedfs) is actively maintained,
  Apache-2.0 licensed and supports S3 plus a small single-host deployment. Adopt
  pinned 4.47 for the bundled deployment, with synchronous SQLite filer metadata
  and explicit bucket fsync. Do not use its asynchronous default LevelDB writes
  as evidence of durable acknowledgement. The inspected
  [SQLite source](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/filer/sqlite/sqlite_store.go)
  accepts explicit SQLite DSN pragmas; the
  [S3 implementation](https://github.com/seaweedfs/seaweedfs/blob/4.47/weed/s3api/s3api_object_handlers_put.go)
  propagates the filer's fsync decision to volume writes.
- [Garage](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/)
  is actively maintained and simpler to operate, but its documented metadata_fsync
  mode still uses SQLite NORMAL or LMDB NOMETASYNC. Do not select that weaker
  single-node power-loss contract for an acknowledged native-history dependency.

Standard S3 keys and a PG reference inventory permit export to another compatible
backend. Copy and checksum every retained object before switching endpoints.
There is exactly one configured attachment-byte authority. The bundled single-host
service proves process restart persistence, not independent-machine HA.

## Ownership, retention and failures

References contain an opaque object ID, MIME type, byte length and SHA-256, never
a mutable Workspace path, public URL or expiring provider File ID. Tenant scope
is imposed by the trusted caller and storage key; guests cannot choose references
or obtain S3/Broker credentials. Reject mismatched/missing bytes visibly.

PG owns a bounded metadata inventory and native-log reference reachability; S3
owns attachment bytes. Inventory rows contain no Tool result, command or model
payload. Uploading/ready/deleting states and row locks serialize retention with
cleanup. A successful upload precedes publication; only the final native log
retains an attachment. Pending uploads belonging to unsealed Runs cannot be
reaped. Unreferenced objects become eligible after closure and a grace interval.
Cold administrative writes retain references transactionally. Forked native logs
retain their own references; deleting the source must not delete the Fork's image.
Pruning a Lane does not erase immutable historical entries or their attachments.

Cleanup commits a deleting claim before S3 deletion and can repeat deletion after
crash. New references cannot attach to deleting objects. A crash before Kafka
publication may leave an orphan, never a successful record with missing bytes.
A crash after publication is recovered by ordinary ordered projection; it does
not execute a Tool again. Provider-hosted image IDs are not durable authorities.

## Limits and acceptance

Decode/resize untrusted images in Cube with a pinned image library through Pi's
public read image-processor hook. Match the inspected Codex dimension/patch rules:
default high is 2048 / 2500 32px patches; original is 6000 / 10000 patches.
Normalize to lossless 8-bit static PNG, strip extraneous metadata, and enforce
explicit input/output byte and decode-pixel limits. Refusal is visible, never a
silent lower-quality retry. Bound concurrent byte transfers and complete model
request sizes as well as each image. Native Compaction owns context reduction.

Acceptance includes: >1 MiB screenshot through a real Cube, Kafka reference-only
payload, genuine GPT-6 Luna vision, consecutive screenshots, overwrite of source,
cold restore, Fork retention, cancellation, corrupt/missing blob, cross-tenant
denial, publication/upload failure and cleanup restart. No image content or
credentials in logs. Document the protocol, config, deployment and observed limits.
