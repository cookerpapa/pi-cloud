# Provider-owned model continuation

Status: deployed on schema 205. Base Worker/application release is
`provider-continuation-20261030` (`d83be048`, platform Helm 130); provider-only
repairs are `provider-continuation-config-20261030` (`904a2e01`) and
`provider-send-once2-20261031` (`ffddca46`, infrastructure Helm 100).
Ordinary-size continuation and recovery are accepted. Further 131 MiB
real-provider testing is deferred at the owner's explicit request. No Pi core
patch or schema change is introduced.

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
tests use a local fake upstream, not the VPN. The refinement is deployed; no claim
of successful 131 MiB provider acceptance is made. The first preparation passed
58 assertions but its test-PG Docker-stop caller timed out. Physical container
absence was confirmed, and a clean preparation passed.

Final `provider-send-once2-20261031` acceptance first completed both ordinary Runs
on the same Worker, so it did not satisfy the distinct-owner assertion despite
correct model/Tool output. The maintained driver now verifies quiescence and
gracefully replaces its idle first owner before the second Run. The repeat passes
with distinct Worker identities: 3,110,449 B cold input, then 19,837 B Tool deltas
and a 20,159 B first request on the new owner. Actual provider Pod transmission is
3,424,618 B and 303,540 B across the two three-request Runs. The fixture's image,
VM, Volume and tenant were reconciled and removed. The source-only replica guard
and local send-failure tests are not represented as a successful large VPN probe.

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
not committed. Deployed network-byte, distinct-Worker and retained-asset checks
are recorded above; large cold-provider completion remains explicitly unverified.

## Retained assets and cleanup

Both dedicated machines retain their stable IDs and Workspace Volumes; only the
matched release replaces compute (generations 31→32 and 1→2). Provider-only
repairs preserve both allocations and all 28 unrelated Pod identities. The second
machine's existing Python PM service is restored with its public-proxy environment;
its original root page hash matches. Its background snapshot had already changed
before publication, so a separate post-stop baseline was captured and verified
before restarting that application. Later application snapshot/log updates are
recorded as runtime changes, never silently treated as lost data.

Four original conversations, all 14 protected account/configuration/native tables,
101 retained image objects and 27 private configuration/credential hashes match.
All 5,889 Workspace files match across the stopped-machine upgrade; final checks
permit only the recorded application's subsequent snapshot/log updates. All 29
serving Pods are Ready, with no active Runs, writers, Tool bindings or acceptance
elastic VMs after cleanup. The isolated provider container and copied credentials
are removed. No user conversation was resubmitted or compacted.
