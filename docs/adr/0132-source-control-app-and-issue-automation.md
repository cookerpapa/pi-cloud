# 0132 — Source-control App and Issue automation

## Status

Accepted.

## Context

PiCloud supports repository-backed conversations and unattended Issue Runs.
ADR-0134 makes Git and its credentials ordinary user-managed Workspace state;
the platform no longer owns a hidden Git baseline or post-processes file
changes into commits.

GitHub Apps provide repository-scoped installations, signed Webhooks and
short-lived installation access tokens. GitLab exposes a similar conceptual
surface through OAuth/project integrations, Webhooks and Merge Requests, but
the two authentication protocols are not interchangeable.

## Decision

PiCloud owns a provider-neutral source-control domain. It ships a GitHub App
adapter and a self-managed GitLab project adapter. Provider connection is a
deployment/API concern; the Web product exposes only GitLab Issue tasks,
claims and execution selection after a configured Webhook creates them.

```text
Browser -> GitHub App install -> PiCloud installation/repository grants

GitHub Webhook -> HMAC gate -> idempotent Issue Job
       -> ordinary Project / Workspace / Session / Run
       -> short-lived App credential in Workspace Git Home
       -> Pi Worker -> Agent git clone -> Cube Git/Tools
       -> uncommitted tested Workspace -> later user-directed delivery

GitLab project token -> encrypted project connection -> signed Project Webhook
       -> pending Issue request
GitLab OIDC user -> non-exclusive claim -> explicit execution selection
       -> OAuth+PKCE credential in selected Workspace Git Home
       -> Agent git clone
       -> ordinary Project / Workspace / Session / Run
       -> uncommitted tested Workspace -> later user-directed delivery
```

The platform GitHub App private key and Webhook secret are deployment secrets.
PostgreSQL stores installation/repository identities and the encrypted
deployment integration credential used for Webhooks and provider API calls. It
is never copied into user execution. A separate OAuth+PKCE grant writes the
user's Git credential directly to `.pi-cloud-home` in the selected persistent
Workspace. The Agent can read and exfiltrate that credential, but it never
enters Pi SessionStorage or Kafka.

Issue execution is explicit. A repository may opt into a deployment-owned
label (default `picloud`) and trusted collaborators may use the exact comment
command `/picloud solve`. Merely opening an Issue never consumes model quota.
GitHub delivery IDs are unique input keys. Provider output is not a side effect
of the initial Agent Run.

GitLab uses a project access token with `api`, `read_repository` and
`write_repository` scopes. PiCloud encrypts it with a source-control credential
master key. Connection creates or reconciles one project Webhook using GitLab's
Standard Webhooks signing-token contract. Comment triggers additionally verify
that the actor is a Developer or higher. The connected project credential is
not a user Git credential.

The default login remains PiCloud-local and GitLab is optional. When configured,
GitLab OpenID Connect is a second authentication provider for one deployment-
selected PiCloud tenant. The authorization-code flow uses discovery, PKCE,
nonce and one-use state. The OAuth access token is discarded after resolving
the GitLab user; PostgreSQL keeps only the provider subject and public profile.
Deployments with split-horizon networking may configure a distinct bootstrap
GitLab API/Git origin. The remote stored in the user repository still uses the
public provider origin so it is reachable from Cube.

A GitLab Webhook creates an `awaiting_claim` Issue request and never starts a
model call. Any matching GitLab user with current Developer-or-higher project
membership may add or remove a non-exclusive human claim. Claims are an
idempotent expression of intent, not a scheduler lock and not an Agent
ExecutionLease. A claimant explicitly starts the request by choosing a new
Issue-dedicated elastic Workspace/profile, a compatible existing Workspace, or
a directory under `/home/user` in one owned running cloud development machine.
The claimant also names the conversation.

Each selected directory is a normal repository. One owned development machine
may hold several independent `.git` directories. The resulting Session records
its initiating PiCloud user. The initial Agent Run implements and tests without
committing, pushing, creating a Merge/Pull Request, commenting on or closing the
Issue. A later explicit user instruction owns those decisions.

The Issue coordinator is not a scheduler. It creates and observes ordinary
PiCloud Runs; the shared PostgreSQL Run queue remains the only Agent execution
queue.

## Alternatives

- A personal access token was rejected because it is user-wide and difficult
  to scope and rotate safely; GitLab uses a project-scoped bot token instead.
- A trusted-only credential proxy was rejected for interactive Workspaces
  because it prevents ordinary Git/CLI behavior and no longer matches the
  accepted threat model.
- Flattening GitHub App and GitLab project authentication into one token model
  was rejected. The domain is provider-neutral, but each adapter preserves its
  native grant, Webhook and Pull/Merge Request semantics.

## Consequences

Both providers are optional. A deployment without either adapter retains the
empty/sample Workspace behavior. GitLab can be accepted locally with the pinned
CE lab deployment; live GitHub acceptance still requires an operator to
register the App and a user or organization owner to install it once.
