# ADR-0150: root-origin streaming application preview

## Status

Accepted. Replaces the path-token proxy mechanics in ADR-0123.

## Problem and evidence

The preview hostname still served applications beneath a long path prefix.
Vite's root-absolute module URLs therefore loaded the PiCloud HTML fallback.
Nonce-only style policy also rejected Vite's runtime CSS. The per-request
JSON/base64 guest HTTP helper could not preserve streaming or WebSocket upgrade.

## Decision

- Keep the authenticated main-origin `preview` bootstrap link. Exchange its
  short-lived target capability on the isolated hostname for an HttpOnly,
  host-only preview Cookie, then redirect to the application's unchanged path.
- A dedicated HTTP listener in the existing Control Plane process owns every
  path on preview origins, including `/v1`, assets, APIs and WebSockets. Caddy
  routes preview hosts there before the main site's SPA fallback. No new
  deployment service or database authority is introduced.
- Use pinned UnJS `httpxy`, a maintained Node HTTP/WebSocket proxy, for HTTP
  framing, streaming and upgrade. Do not rewrite HTML, JavaScript or CSS URLs.
- Tool Broker authorizes a private HTTP CONNECT request for a tenant/user,
  target and application port. It opens a provider-neutral byte stream and
  never returns Cube credentials or addresses to the browser.
- The current Cube templates expose envd only and do not offer dynamic public
  port allocation. Use Cube's existing envd Process Start/SendInput stream to
  run a credential-free, unprivileged TCP relay for that connection. It targets
  only the selected guest loopback port, has no listening port or resident
  controller, and exits when the connection ends. Do not widen template port
  exposure or make the host's own loopback a target.
- Preview authority is bounded by expiry and current resource ownership. Strip
  the preview Cookie and reserved platform headers before forwarding; keep app
  cookies host-scoped and prevent the app from overwriting preview authority.
- Isolation comes from separate origins and credentials. Permit inline/dynamic
  styles and development scripts within that origin; retain self-only network,
  form and framing boundaries. Keep WebSocket origin/expiry checks.
- Remove the buffered guest HTTP helper and path-token serving fallback rather
  than maintaining two preview transports.

## Adopt-before-build sources

- [Vite backend integration](https://vite.dev/guide/backend-integration): root
  module and asset requests must reach the development server.
- [Cube ingress](https://github.com/TencentCloud/CubeSandbox/blob/v0.6.0/docs/guide/connect-existing-cluster.md): native HTTP/WebSocket ingress depends on
  exposed template ports; prefix mode does not solve SPA absolute paths.
- [UnJS httpxy](https://github.com/unjs/httpxy): HTTP streaming, WebSocket
  upgrade and Node Agent integration without another proxy service.
- Cube's existing envd Process transport is already used for commands and PTYs;
  the new byte-stream adapter uses stdin/stdout, never a PTY.

## Acceptance

Verify the unchanged user Vite game, root assets and dynamic CSS, HMR and a
plain WebSocket echo, incremental SSE, binary HTTP, query strings, redirects,
cookie isolation, missing/expired/wrong-origin authority and released targets.
Keep the main application APIs unreachable from a preview hostname. Prove
connection cleanup does not terminate the application service or leak relays.
