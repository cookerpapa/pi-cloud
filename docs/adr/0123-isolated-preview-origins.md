# ADR-0123: isolated application Preview origins

## Status

Accepted on 2026-08-25. Origin isolation remains current; ADR-0150 replaces
the original path-token and buffered-proxy mechanics.

## Context

Serving untrusted Cube HTML on the PiCloud application origin required an
opaque CSP sandbox. That prevented host privilege escalation but also made
ordinary browser APIs such as `localStorage` throw before application handlers
were registered. The result was a visible Snake page whose Start button could
not run.

## Decision

The authenticated main-origin Preview route issues a short-lived HMAC
capability scoped to tenant user, conversation or development environment,
application port and expiry. It responds with HTTP 307 to a deterministic
target/port subdomain below the deployment-owned Preview base domain:

```text
https://p-<target-hash>.preview.example.com/
```

The isolated origin verifies the capability, Workspace binding and hostname,
exchanges it for a host-only HttpOnly Cookie, and redirects to the app's root
path. PiCloud browser cookies remain on the main origin; Preview authority is
stripped before application requests enter the Broker connection. The bootstrap
uses `no-referrer`, expires after fifteen minutes and cannot grant a different
target, Workspace or port. See ADR-0150 for the streaming transport.

Because the application is no longer same-origin with PiCloud, its CSP sandbox
may include `allow-same-origin` together with scripts, forms and downloads.
Application assets, routing, IndexedDB and localStorage work normally within
that target/port origin. Frame ancestors remain denied.

Local Compose uses `*.preview.localhost`; production ingress and TLS must cover
`*.preview.<application-host>`. Cube addresses and public port mappings remain
hidden from both model and browser.

## Consequences

Preview DNS/TLS is now an explicit deployment requirement. A real Chrome
acceptance followed the redirect and exercised Snake start, movement, pause and
reset—not merely HTTP reachability.
