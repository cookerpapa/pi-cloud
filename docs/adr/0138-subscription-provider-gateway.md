# ADR-0138: Subscription provider gateway and separate operator surface

## Status

Accepted on 2026-08-31.

## Context

Pi natively supports API-key providers and subscription-backed OAuth providers,
including OpenAI Codex. PiCloud previously terminated only DeepSeek Chat
Completions inside every trusted Worker and stored one encrypted provider key in
PostgreSQL. That made model account lifetime, provider quota and Agent execution
look like one concern, prevented native Responses use and required PiCloud to
reimplement provider-account administration.

CLIProxyAPI is an actively maintained MIT-licensed provider gateway with native
Codex OAuth, API-key channels, Responses/Chat/Anthropic protocol support,
quota/cooldown handling, refresh singleflight and session-aware account
selection. Its runtime and management APIs are adopted behind PiCloud-owned
ports rather than copied into the product UI.

## Decision

### Authority boundaries

- PostgreSQL remains authoritative for users, Sessions, Runs, immutable model
  choice and the stable provider route selected for a Turn.
- PiCloud's Worker-local Model Gateway remains the only endpoint visible to Pi.
  It validates the Run capability, model binding, Step identity, cancellation
  and bounded request count before forwarding a request.
- CLIProxyAPI owns upstream OAuth/API credentials, token refresh, provider quota,
  account cooldown and concrete account selection. Actual provider quota remains
  authoritative at the upstream provider.
- PostgreSQL stores a non-secret route binding, never an upstream Access Token,
  Refresh Token or API key. Provider secrets live in CLIProxyAPI's private,
  deployment-owned credential Volume.
- PiCloud may record provider/model/token/latency observations for diagnosis, but
  they are not a competing quota ledger or billing authority.

### Protocol and affinity

- DeepSeek uses Pi's OpenAI Chat Completions adapter. OpenAI Codex uses Pi's
  native Codex Responses adapter. Provider wire protocols are not flattened to
  Chat Completions before Pi.
- Pi supplies a stable Session ID to every model request. CLIProxyAPI enables
  session affinity so the same provider account and prompt-cache route are
  preferred for later requests in that Session.
- Affinity is soft: a bound account may be replaced only when it is unavailable.
  A switch never occurs inside an accepted stream. A partial or ambiguous model
  request is settled through the existing interruption boundary before another
  account handles a later sampling Step.
- The Worker-local capability Gateway may repeat a CLIProxy request only when no
  response bytes were exposed and CLIProxy returned a transport-class 5xx (or
  the internal connection failed). It never retries a partial stream; CLIProxy
  remains the account-selection and provider-quota authority.
- The one-host deployment runs one active CLIProxyAPI replica. Its affinity cache
  is an optimization and may be lost on restart; PiCloud correctness relies on
  PostgreSQL Pi SessionStorage and full-context replay, not on provider cache.
  A future multi-replica gateway must externalize or shard affinity explicitly.

### Deployment and management

- The one-host profile pins CLIProxyAPI `v7.2.146` by OCI digest and mounts a
  private credential/config Volume. Distributed deployment treats the gateway
  as an external service unless an equivalent pinned in-cluster deployment is
  supplied.
- Runtime traffic reaches only the internal CLIProxyAPI endpoint. The management
  UI is exposed on a loopback/admin-network port and is never proxied through the
  public conversation origin.
- The user application remains on port `8080`. PiCloud's operator landing page
  moves to port `8081` and links to the native CLIProxyAPI Management Center,
  Grafana, Prometheus, Alertmanager and Jaeger. PiCloud does not recreate those
  management interfaces.
- CLIProxyAPI's management asset is pinned by the deployment; runtime panel
  auto-update is disabled. Management credentials are never placed in a URL or
  exposed to the normal product bundle.

## Consequences

- Provider subscription/API capacity can change independently of Pi Workers and
  Cube compute.
- Adding a Pi-supported provider primarily becomes CLIProxyAPI configuration and
  a bounded PiCloud model-route declaration, not another credential vault and
  streaming implementation.
- The current encrypted DeepSeek credential path is removed after the deployment
  credential is imported into CLIProxyAPI; there is no dual credential authority.
- Provider-gateway loss prevents new Run claims and does not revoke already
  committed conversation or Workspace state.
- Subscription pricing and limits are operational capacity, not a correctness or
  exactly-once guarantee.
