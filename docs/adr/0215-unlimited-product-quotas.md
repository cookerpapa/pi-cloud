# ADR-0215: No default resource or product quotas

Status: accepted; implementation in progress (2026-10-03).

## Owner decision

During ADR-0214 acceptance, small container memory limits killed the Worker and
provider gateway on valid image requests. The owner requested removal of limits,
then explicitly included Session count, concurrency and upload-size product quotas.
This extends the K3s work; it does not authorize replacing Pi, PG or Kafka authority.

## Scope and representation

The self-hosted deployment must not impose CPU/memory hard limits or a manually
selected Go memory ceiling. Scheduling requests remain. Remove PiCloud's fixed
kubelet PID ceiling using the Kubernetes-supported unlimited setting; do not use
a large fabricated number. VM CPU/memory specifications remain real allocations:
a KVM machine needs a finite specification, and Cube can still report physical
capacity exhaustion.

Product policy uses an explicit absence of a limit (`null`), never a large integer
sentinel or a special legacy mode. Existing policy columns that remain useful for
explicit operator configuration become nullable and default to no quota. Existing
deployment quotas are cleared as requested. The same rule applies to tenant,
project, Session and sandbox-count quotas; Worker family/model concurrency and
Subagent depth/count budgets have no default product ceiling. Any explicitly
configured future limit is a current policy, not a compatibility branch.

This does not remove per-Lane ordering, one Session writer, PG-issued ownership,
leases, fencing, cancellation, scoped stopping or closure proof. Worker admission
still stops for measured memory pressure or an unavailable execution plane.
The memory watermark uses the smaller of physical RAM and the cgroup budget:
[libuv](https://docs.libuv.org/en/v1.x/misc.html#c.uv_get_constrained_memory)
may report `UINT64_MAX` for an unlimited cgroup, which must not block every claim. Local
claim batches, database connection pools and transport queues retain backpressure;
batch size is not a cap on total accepted work. Protocol validity, request/Tool
timeouts, shutdown budgets and provider/native SDK constraints remain distinct
from user quotas. Their removal is not implied by this decision.

## Upload boundary

Remove the 16 MiB per-file, four-file, 32 MiB per-input and pending-draft product
quotas. Simply removing a Buffer length check would move the failure to the heap.
Use ordinary streaming HTTP bodies and bounded chunks through the existing upload
ports. The persistent Cube Volume stays the only Workspace byte authority;
immutable Session images retain their existing S3 authority. The control plane
must not acquire a second file archive or spool authority.

Preserve complete-content hashes, immutable upload identity, exclusive publication,
lease/claim fencing, cancellation and acknowledgement only after durable placement.
The browser/API supplies the content identity before streaming; receivers verify
the actual stream. A long, progressing transfer renews its upload claim, while a
disconnected or stalled transfer remains recoverable. Changed-content retries must
not overwrite user modifications. Native image decoding still has to fit the
runtime/provider's capabilities; unlimited Workspace upload does not promise an
unlimited LLM context or bypass a provider's request limits.

Use standard HTTP streaming/digest and existing ports instead of introducing a
resumable-upload service, second queue, blob checkpoint head or compatibility
endpoint. Validate any required dependency against its official source/license
before adoption. Record the exact transport contract with the implementation.

### Streaming transport selection

- The public upload remains HTTP PUT. Require a declared length and
  `Content-Digest: sha-256=:BASE64:` under [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html).
  This declares retry identity before byte placement; receivers verify it against
  the actual stream. It is integrity metadata, not authentication or a new signature.
- Reuse the pinned [Fastify stream parser](https://fastify.dev/docs/latest/Reference/ContentTypeParser/),
  Node streams, Cube's existing file endpoint and the existing AWS S3 adapter.
  The browser hashes bounded chunks with pinned
  [@noble/hashes 2.4.0](https://github.com/paulmillr/noble-hashes), an actively
  maintained MIT-licensed implementation supporting incremental SHA-256. Test
  cancellation/chunking and compare digests with Node's crypto implementation.
- [tus](https://tus.io/protocols/resumable-upload) is a maintained standard option
  when resumable offsets are required. This request removes size quotas; adding
  another offset/staging lifecycle would exceed the current requirement. Retry
  the complete stream under the same verified identity; do not claim resumability.
- Image streams also reach the existing attachment store with backpressure.
  Draft reachability and renewable claims must cover a transfer longer than the
  old two-minute lease/24-hour draft age. Control Plane does not spool user files.

## Acceptance

- Self-hosted Pods have no CPU/memory limits and no PiCloud Go memory ceiling;
  resource requests and actual VM specifications remain explicit.
- New and existing tenants can exceed the old project/Session limits; unrestricted
  concurrency can exceed the former four-request/family defaults, while stop,
  cancellation, same-Lane ordering and fencing tests still pass.
- Upload files and attachment lists beyond the previous limits end to end;
  memory consumption of transport does not grow with an entire generic file.
- Corruption, duplicate identities, user-modified destinations, cancellation,
  disconnection and claim expiry do not publish a partial file or false success.
- Remove retired quota UI/configuration defaults and document real remaining
  protocol/provider/physical constraints. Deploy matched API, Worker and guest
  contracts, with no old-wire fallback.
