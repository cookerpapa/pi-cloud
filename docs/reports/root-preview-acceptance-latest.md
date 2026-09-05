# Root-origin Preview acceptance — 2026-09-05

Tested base: `46be67ad` plus this working tree, on one WSL host with PostgreSQL,
Kafka, two Pi Workers and real Cube KVMs. Changed Control Plane, Broker and Web
images were rebuilt/deployed. Existing user machines were adopted, not replaced.

## Root correction

An isolated hostname now owns the application's entire URL space. The main
application issues a short-lived bootstrap; the preview listener exchanges it
for a host-only HttpOnly Cookie and redirects to the real application path.
UnJS `httpxy` streams HTTP and WebSocket through an authenticated Broker CONNECT
and a connection-scoped envd stdin/stdout TCP relay. No HTML/base-tag/JavaScript
URL rewriting or buffered guest HTTP helper remains. Platform authority never
enters application headers or cookies. Main `/v1` API routing remains separate.

## Existing user Vite Snake

The original Vite 7 game was opened on the actual deployed preview origin:

- root `/src/main.js`, `/@vite/client`, dynamic CSS and Vite runtime modules loaded;
- the styled game rendered; Start changed the game state/canvas and Pause showed
  the pause overlay;
- the Vite HMR WebSocket connected successfully;
- the preview Cookie was inaccessible through `document.cookie`;
- SHA-256 comparison against the original Tool writes confirmed all four source
  files unchanged; the original development machine remained `running`;
- a subsequent read-only guest process inspection found zero remaining preview
  relay processes after closing the browser.

The first rendering probe also exposed Google Fonts being blocked by the old
self-only static-asset policy. HTTPS scripts/styles/fonts/images are now allowed
within the isolated page; network and form actions remain self-scoped. Actual
external asset availability still depends on the user's browser network.

## Repeatable live regression

[Vite acceptance](vite-preview-acceptance-latest.json) used real DeepSeek V4 Flash
and a new elastic Workspace. The model created a normal Vite application on
5173 plus an HTTP/SSE/WebSocket API on 5174. A second Run changed only its CSS.

- Both root application origins loaded and application cookies received no
  platform/preview credentials.
- CSS changed through HMR while the browser instance ID and counter remained
  unchanged: no full-page reload.
- WebSocket binary bytes `[0,255,65,13,10]` round-tripped unchanged.
- SSE delivered the first event in 83 ms and the last event by 1,466 ms, proving
  incremental forwarding for this sample, not a throughput/percentile claim.
- No CSP violations occurred in the self-contained test application.
- Model Runs took 134,216 ms and 2,905 ms; native usage totaled 11,062 input,
  5,504 output and 175,104 cache-read tokens.

[Multi-service isolation](preview-isolation-acceptance-latest.json) used two
concurrent Sessions with the same guest ports 3000/8000. All returned their own
markers. One Session then retained services on 3000, 8000 and 5173 across Turns.

## Deterministic and deployment checks

326 related tests passed; three opt-in infrastructure tests were skipped by
that command. Separate live tests above exercised the real Cube path. Coverage
includes bootstrap exchange, expiry, wrong host/Origin/user, resource release,
management-port denial, CONNECT authority, streaming SSE, binary HTTP/WebSocket,
redirects, cookie stripping, connection expiry and the existing Broker APIs.
Repository typechecks, Caddy validation, Helm/network-policy validation,
documentation and image dependency-closure checks passed.

The temporary test Sessions/Workspaces were deleted and the Vite test Volume
purge confirmed. Existing user code and machines were preserved. Kafka/database
audit records use normal retention; the shared topic/database was not reset.
Temporary browser profiles and diagnosis screenshots were removed.

Reproduce with `PI_CLOUD_LIVE_VITE_PREVIEW_CHECK=1 npm run production:vite-preview-check`
and `PI_CLOUD_LIVE_PREVIEW_ISOLATION_CHECK=1 npm run production:preview-isolation-check`.
For an already-open old path-token tab, reopen **Open application** from PiCloud;
the retired URL format is deliberately not a compatibility serving path.
