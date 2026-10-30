# Provider-owned model continuation

Status: implementation/source acceptance complete; matched publication and deployed
acceptance pending. ADR-0289 replaces the Worker-owned socket cache with an
in-process provider adapter. No schema change or Pi core patch.

## Behavior

Pi supplies complete effective context over HTTP/SSE inside the cluster. The
current Run's gateway grant still owns request admission and cancellation. The
provider adapter uses CPA's existing credential manager and native executor,
retaining completed upstream connections by an opaque tenant/Session/Conversation/
credential-version/purpose key. Compatible requests send only their new suffix to
OpenAI. Idle caches retain fingerprints rather than historical image base64.

The existing owner/lease/Kafka/PG and Tool-result authority remain unchanged.
Changed input/properties and missing response state cold-open from supplied full
context. Cache eviction/restart has no independent recovery log. Cancellation
closes active upstream work; ordinary reader cleanup after a completed event does
not discard the idle connection. Scoped removal of CPA's five-minute reader
deadline allows its explicit 15-minute idle owner to work; active waits still use
native event inactivity and HTTP cancellation. Ordinary CPA clients retain their
reader deadline. A pre-output WebSocket transport failure can fall back once to
HTTP, retaining a bounded five-minute fallback preference. Semantic errors and
partial outputs do not acquire an extra retry owner.

The initial decoded request boundary is 256 MiB, with a 512 MiB retained-upload
budget per process and one self-hosted configuration source for Worker/provider.
Actual chunks are reserved before retention, so small requests do not each occupy
a maximum-size slot. The Web explains oversize and recommends manual `/compact`.
Native token compaction and image quality are unchanged. Internal full-input
traffic remains; upstream reuse is the bandwidth optimization.

## Verification before publication

- Workspace typechecks/tests/helpers: 2,404 assertions passed; existing opt-in
  skips retained. The deterministic fault run passed 379/379 cases. Its report
  retains the actual pre-commit revision and dirty-tree stamp.
- Provider Go race tests exercise separate HTTP clients, actual native Pi Models
  serialization in separate processes, image/Tool deltas, cancellation, context
  replacement, expiry, missing response, HTTP fallback, admission and late cleanup.
- Valid 129 MiB decoded requests pass both adapter boundaries. Oversize and invalid
  zstd remain distinct and never reach the provider. Small concurrent uploads use
  actual byte reservations. The isolated Go decoder-boundary process peaked at
  586,196 KiB RSS; logical upload accounting is not an RSS/process-memory cap and
  this measurement includes synthetic fixture allocations.
- Browser presentation, Helm/distributed/self-hosted render, runtime policy,
  documentation, image closure, formatting and Docker build-context gates pass.
  The browser check caught a Node-only crypto import in the shared protocol;
  Web Crypto replaced it and the actual page check passed.

An isolated provider image used copied private credentials without changing the
serving provider or user conversations. Real GPT-6 Luna returned a Tool call,
accepted its result, recalled a synthetic image and continued after the local
Gateway/grant was replaced. Approximately 747 KB full input became 749 B and
766 B selected upstream requests. A separate six-minute idle run also retained
the upstream continuation and recalled the image. These are single samples, not
latency percentiles or a guarantee that arbitrary cold images will succeed.

The first real probe incorrectly called Pi's internal provider API with an
unnormalized Context, so the model did not receive the test Tool. The fixture now
uses the public Models registry; the corrected local and real contracts pass.
No production behavior was changed to accommodate that fixture error.

The probe container and copied credentials were removed. Private reports are in
`deploy/production/runtime/work-evidence/provider-continuation-20261030/`; they are
not committed. Deployed acceptance must additionally verify actual provider
network bytes, distinct Worker processes, retained assets and full-input recovery.
