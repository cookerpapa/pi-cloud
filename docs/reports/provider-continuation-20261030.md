# Provider-owned model continuation

Status: implementation/source acceptance complete; matched publication and deployed
acceptance pending. ADR-0289 replaces the Worker-owned socket cache with an
in-process provider adapter. No schema change or Pi core patch.

Matched `provider-continuation-20261030` (schema 205, Helm 130) exposed a deployment
rendering error before deployed model acceptance: large numeric environment values
were emitted in scientific notation. Strict Go configuration rejected them during
lazy request initialization, then left the cache uninitialized. Render decimal
integers and validate the cache at server construction. Regression tests cover
actual Helm output, startup refusal and narrowly scoped manifest normalization.
The failed owned fixture was fully cleaned; it is not counted as acceptance.

The provider-only decimal/startup repair was deployed as
`provider-continuation-config-20261030` from `904a2e01`. The 28 unrelated Pod
identities and both development-machine allocations remained unchanged. Deployed
Luna/Cube/browser acceptance now passes: distinct Workers perform two Runs with
two Bash tools each, retain image context and reuse the provider connection. The
second Run's first selected upstream payload is 20,159 B instead of 3,111,646 B
full input. Provider Pod transmission is 3,462,265 B for the first three-request
Run and 300,388 B for the second; these counters also include returned responses
and incidental provider traffic. Stop, queue editing, Worker crash and simultaneous
Worker/Control Plane crash pass the maintained native-input driver, with owned
fixtures physically reconciled and removed.

Two approximately 131 MiB cold-image probes, including after the owner's proxy
node switch, passed the local size boundary but did not receive a response within
300 seconds. The proxy logged resets during upstream writes. It also exposed a
redundant CPA reconnect/resend before HTTP fallback. The owner explicitly deferred
further large real-model probes and requested that duplicate send be fixed.
The scoped executor guard now suppresses that extra send/account retry, while a
failed HTTP attempt retains only a bounded fallback preference. Local failure
tests reproduce two upstream connections without the guard and pass with one WS
attempt plus one HTTP fallback; cancellation cannot retain failed context. These
tests use a local fake upstream, not the VPN. Publication of this retry refinement
is pending; no claim of successful 131 MiB provider acceptance is made.

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
