# Preview answer links — 2026-10-24

Deployed release: `preview-answer-16f8f8b5`, source
`16f8f8b5489e13515d2d48dcb0dd4828c0254c92`, platform Helm revision 96.
Schema 198, Pi 1.0.0 and managed/guest protocols 8/7 remain unchanged.

## Behavior

Preview returns the existing verified platform path to the model. The answer's
named Markdown link is the application entry. The standalone action component,
collapsed-group duplicate action, port-bearing button labels and their CSS were
removed. No answer-link parser, deduplication rule or missing-link fallback was
added. Preview arguments, raw output and duration remain in closed Tool details;
child progress still appears independently of those details.

The Worker instruction now asks for an application-name link and omits an internal
port label unless requested. Existing answer text is not rewritten. Reload an
open browser to load the changed presentation. Service discovery, authorization,
HTTP/WebSocket proxying and canonical Tool results retain their existing contracts.
The [ADR-0270 amendment](../adr/0270-guest-browser-and-tool-result-actions.md)
records the owner-approved presentation decision.

## Verification

- Web and Runner type checks plus 194 relevant tests pass. Browser tests cover
  live/recovered answer links, collapsed groups, standalone Preview details,
  retained port/result/duration information, and no generated fallback when an
  answer omits a link. Existing composer, input handoff and child displays pass.
- Dependency repairs below pass type checks in all seven affected workspaces and
  73 HTTP, model-gateway, preview, guest-client and deployment contract tests.
  Node 24.22.1 runs and performs normal Brotli codec operations on the retained
  Ubuntu Cubelet and guest bases.
- All 12 matched artifacts pass provenance and the existing zero-fixable-
  HIGH/CRITICAL gate. Preflight passes before and after deployment. The rebuilt
  guest passes unprivileged browser interaction, canvas, screenshot, native Read,
  path semantics and cancellation/timeout cleanup checks.
- Real GPT-6 Luna acceptance makes four model requests through Bash, screenshot
  Read and Preview. Its named answer link is the only application action in both
  live SSE presentation and refreshed history with Tools collapsed. The answer
  does not display an internal port label. Following the actual platform link
  opens the application and its button interaction succeeds.
- The owned acceptance conversation, Workspace, screenshot image and temporary
  tenant are cleaned up after writer closure and confirmed physical storage purge.
  The driver has an explicit `browser` scope for this acceptance; default full
  release acceptance remains available.

## Release dependencies and retained failed samples

The first prepare process received SIGTERM during scanning, before any serving
resource changed. Resuming the existing scan phase exposed actionable findings
in Undici 6.28.1 and Alpine Brotli 1.1.0-r2. No exception was added. The release pins
[Undici 6.29.1](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c),
[Alpine Brotli 1.1.1-r0](https://pkgs.alpinelinux.org/package/v3.21/main/x86_64/brotli-libs)
and the official [Node 24.22.1 security release](https://nodejs.org/en/blog/release/v24.22.1),
which also repairs Node's bundled decoder and Undici. Node's backported Brotli
still reports `1.2.0`; the fixed Node release/digest identifies the applied repair.

The Node image is pinned by digest. Its unavailable Bullseye variant was replaced
by the official Bookworm donor while retaining Ubuntu runtime bases and building
native completion modules on their target Ubuntu ABI. CI uses the same Node version.

The changed guest inputs invalidated the browser installation layer. Repeated
Chromium CDN TLS failures were resolved by seeding a normal BuildKit revision
cache from the previously verified immutable guest artifact, after comparing its
browser package-lock hash. The pinned installer still selects the revision and
populates a cold cache normally. The final image copies those files and runs all
browser checks; no old Node binary, runtime fallback or browser daemon is added.

Initial failed scans/download logs and their evidence remain separate from the
successful final release. The source commits are `8d453c58` for presentation,
`359e4a56` for dependency pins and `16f8f8b5` for the browser build cache.

## Preservation

The existing matched operator required drained writers and absent native compute.
The original allocation was closed and confirmed absent on its recorded node
before its live handle was cleared. Logical machine identity, running intent,
Workspace identity and both conversations remain. The controller recovered
machine generation 5 with Node 24.22.1.

Both previously running applications were restored using their recorded startup
commands. Their HTTP response-body hashes match before/after. All 15 protected
PG snapshots and all 27 credential-file hashes match. All 43 Workspace files
remain; 41 source/artifact files match exactly. Only the expected server PID and
appended server log changed. Model/provider configuration was not reset.

Final state: 28 Ready Pods, one completed migration Pod, HTTP 200, one ready
retained machine and zero unfinished Runs, writers, Tool bindings, elastic
acceptance fixtures or terminals.

Private operational evidence is under
`deploy/production/runtime/release-evidence/preview-answer-20261024/`; final image
evidence is under `deploy/production/runtime/releases/preview-answer-16f8f8b5/evidence/`.
User repositories, transcripts, credentials and screenshots are not committed.
