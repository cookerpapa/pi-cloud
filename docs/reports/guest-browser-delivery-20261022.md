# Guest browser, preview actions and shared proxy delivery

Runtime source `bd03f7a6` is deployed as `guest-browser-bd03f7a6`, schema 197,
under [ADR-0270](../adr/0270-guest-browser-and-tool-result-actions.md) and
[ADR-0271](../adr/0271-local-upstream-proxy-configuration.md). Matched preparation,
artifact preflight and application completed successfully. Real Luna browser,
screenshot and preview acceptance passes, with owned fixture cleanup confirmed.
Native recovery and final protected-state comparison also pass as recorded below.

## Behavior

The standard Cube guest includes locked Playwright 1.64.1, its matching Chromium
and CJK fonts. The ordinary unprivileged Tool user imports
`/opt/pi-cloud/browser/index.mjs` from Bash, launches Chromium when needed,
interacts with the application, saves a screenshot and closes the browser. Native
Read sends that image through the existing attachment transport. No browser
service, new executor or Pi core modification is introduced.

Tool display descriptions retain a reference to bounded result metadata in the
same native commit. Live and cold display therefore expose the same structured
preview action. Successful application links remain visible outside collapsed
Tool groups. Preview also returns its authenticated path in text so the Agent can
include a working Markdown link, without claiming the webpage has already rendered
one. Failure or invalid metadata does not render a successful action.

The local upstream address is now `http://127.0.0.1:12450`. The operator command
`npm run production:proxy -- http://127.0.0.1:12450` updates the private requested
address, provider Helm settings, Cube's existing settings service, Docker and K3s
proxy environments. Build/release commands and the shell helper read that address.
Cube egress enablement is retained. Reapplying the same value preserves the PG
revision and service identities; configuration synchronization is retryable, not
an atomic distributed transaction.

## Source and artifact verification

- Focused browser/display/native checks passed 373 cases across 57 files. The
  complete application/helper/transport suites passed 2,157 cases.
- The first full fault invocation passed 341 of 361 cases. Its two failing groups
  passed unchanged on isolated PostgreSQL repeats: 12/12 ownership cases and 8/8
  seal/projection cases. The original invocation remains a failure; no runtime
  timeout or assertion was relaxed to relabel it.
- Proxy synchronization tests passed 31 relevant cases; the final release-download
  helper repeat passed five cases. Type, format, documentation and install checks
  passed for the implementation.
- Guest-image checks exercised Chromium as uid 1000 through native Bash/Read:
  Chinese text, click/canvas interaction, screenshot reading, normal close,
  timeout cleanup and Agent Stop cleanup. Host-browser presentation checks also
  passed; these are distinct from the KVM/model gate below.
- All eleven final artifacts passed provenance/SBOM and the existing zero-fixable-
  HIGH/CRITICAL policy. Go binaries use pinned 1.26.10; Cube's certifi is pinned
  to 2026.10.19. Native Cube admission/allocation/Volume contracts passed.
- The initial npm audit could not reach the exhausted old proxy. After the port
  update, the online audit passed its HIGH gate; remaining findings were moderate.
  The separate browser package audit reported no vulnerabilities. The independent
  Trivy lockfile scan included development dependencies and found no HIGH/CRITICAL
  findings. Unavailable and successful audit attempts remain separate evidence.

The candidate and eleven artifact reports are under the private
`dist/releases/guest-browser-bd03f7a6/` directory. Source, proxy, rollout and live
records are under
`deploy/production/runtime/review-evidence/guest-browser-20261022/`.

## Deployment and retained failures

The owner explicitly authorized releasing the current development machine and
deleting its Workspace. The existing lifecycle service persisted the release;
Control Plane reconciliation confirmed physical storage purge before matched
cutover. The first host-side call lost its response, and retrying the same
idempotency key confirmed completion. The original conversation remains available.
Its deleted application files are not restored by the release; continued work
requires a new Workspace binding.

The proxy operator's first Docker restart exceeded the former 60-second wait
while BuildKit initialized. The service completed normally; the operator now
uses a bounded five-minute readiness check. The normal K3s service restart
preserved all 29 Pod/container identities; the killall operation was not used.
Final unchanged-address reapplication retained Docker/K3s process IDs, Worker and
Relay identities and Cube settings revision 8. HTTPS requests through host,
model Relay and Cube egress verified the configured routes.

The first real-model acceptance failed before its cancellable Tool fixture:
CLIProxyAPI recorded four upstream TLS-handshake EOF failures. Its owned resources
were fully cleaned. On continuation, brief proxy-domain timeouts were followed by
successful Luna text/function probes (both requests HTTP 200). The unchanged
full browser/Read acceptance then passed. Both invocations remain separate evidence.

## Live acceptance

The unchanged `PI_CLOUD_LIVE_GUEST_BROWSER=1` release driver passed:

- Browser admission-reply loss, native queued input, Stop, returned draft/image
  and resend with a new admission identity; Luna read the reattached image directly.
- Native Read of 120,017-byte ASCII and 140,031-byte Unicode fixtures, bounded to
  51,200 and 51,196 content bytes with valid UTF-8 and canonical truncation guidance.
- Actual guest Chromium click/canvas interaction, screenshot storage, native Read
  and Luna recognition of the random screenshot code.
- Preview action arriving while the conversation page was already open, remaining
  visible in collapsed cold history after refresh, and actual navigation/clicking
  in the application. The model's answer included the returned preview path.

The fixture tenant, physical Workspace storage and two owned image objects were
removed. The unchanged native-input driver also passed all five scenarios:
consume, Stop, Worker crash with same-Run continuation, streaming Stop and
simultaneous Worker/Control Plane crash. Recovery retained native queued edits,
kept one SSE connection through generation 1 → 2, preserved interrupted text and
kept streaming bodies out of PG. Its tenant and physical Workspace were removed.
The missing-container message during the dual-crash fixture came from its cleanup
attempt to resume the already-killed process; kubelet confirmed both crashes and
the resumed Run completed the acceptance assertions.

## Final preservation and scope

All 203 baseline rows across the seven account/configuration tables match their
pre-release fingerprints, excluding only the previously declared usage/update
timestamps. All 27 private credential/configuration files match too. No tenant
created by this delivery remains. The comparator preserves the full fingerprint multiset: credential
bindings can have multiple versions under the same tenant/id, so an initial
identity-only map incorrectly collapsed two rows. Correcting this private checker
required no database mutation and did not exclude any protected field.

The original conversation remains unpruned; the authorized old Workspace has both
logical deletion and confirmed physical purge. All 29 cluster Pods are Ready or
successfully completed, and the web endpoint returns HTTP 200. The owner can
continue the conversation after selecting a new Workspace.

These checks establish the browser/preview/proxy slice and existing native recovery
behavior on this deployment. They do not establish that every application renders
correctly, guarantee upstream proxy availability, or constitute a new full-fleet
capacity/HA certification. The initial failed fault/model/audit attempts remain
distinct from their successful repeats. Only documentation changed after the
tested runtime release; no additional runtime rollout is needed for this report.
