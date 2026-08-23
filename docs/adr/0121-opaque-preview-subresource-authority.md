# ADR-0121: opaque Preview subresource authority

Status: accepted

## Context

PiCloud serves a Cube application through an authenticated same-origin Preview
path. The top-level response uses CSP `sandbox` without `allow-same-origin`, so
untrusted application JavaScript receives an opaque origin and cannot use the
user's PiCloud origin authority.

That boundary also means browser subresource requests do not carry the
SameSite login cookie. A plain `<base>` can route relative paths through the
gateway, but CSS, JavaScript and images receive 401 responses. Adding both
`allow-scripts` and `allow-same-origin` would let application code recover the
PiCloud origin and is therefore not acceptable.

## Decision

- Keep the Preview document sandboxed without `allow-same-origin`.
- After authenticating the top-level request, issue a short-lived HMAC-signed
  Preview authority scoped to tenant, user, public target and port.
- Put that authority in a reserved path segment used as the rewritten HTML
  base. Relative scripts, styles, images, forms and application fetches remain
  under the same bounded Preview capability without receiving a platform
  login cookie.
- Verify the signature, expiry, target and port before resolving Tool Broker or
  Cube state. Strip the reserved segment before forwarding the request into
  the guest.
- Send `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and
  `Cross-Origin-Resource-Policy: cross-origin`. The latter is required because
  the caller intentionally has an opaque origin.
- The capability is accepted only by the matching Preview route. It cannot
  authenticate Control Plane APIs, Tool Broker RPC, another Session,
  environment or port.

## Invariants

1. Untrusted Preview JavaScript never receives the browser Session cookie or a
   general PiCloud credential.
2. A copied, modified, expired or cross-target capability fails closed.
3. Guest response bodies, Tool output and model context never contain the
   platform signing secret.
4. Initial Preview access still requires normal tenant/user authentication.
5. No application path can be interpreted as the reserved authority segment
   unless it carries a valid signed capability.

## Consequences

Multi-file Web applications run through the current single-origin deployment
without weakening the CSP sandbox. The short-lived path capability may appear
in local browser diagnostics, so it is scoped, non-cacheable and protected
from referrer leakage. Long-lived HMR/WebSocket renewal remains separate
future work; refreshing the authenticated top-level Preview obtains a new
authority.
