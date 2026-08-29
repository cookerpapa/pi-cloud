# 0132 — Source-control App and Issue automation

## Status

Accepted.

## Context

PiCloud can execute Git commands inside Cube, but an untrusted Cube must not
receive a long-lived personal token or a GitHub App installation token. The
Workspace intentionally exposes no platform-owned `.git` directory: Git
metadata lives in the trusted Volume envelope. Repository connection and Issue
automation therefore have to preserve the existing Agent/Tool split instead of
adding credentials to Bash.

GitHub Apps provide repository-scoped installations, signed Webhooks and
short-lived installation access tokens. GitLab exposes a similar conceptual
surface through OAuth/project integrations, Webhooks and Merge Requests, but
the two authentication protocols are not interchangeable.

## Decision

PiCloud owns a provider-neutral source-control domain. It ships a GitHub App
adapter and a self-managed GitLab project adapter; the Web product currently
exposes GitLab while the GitHub adapter remains deployment/API-only.

```text
Browser -> GitHub App install -> PiCloud installation/repository grants

GitHub Webhook -> HMAC gate -> idempotent Issue Job
       -> ordinary Project / Workspace / Session / Run
       -> trusted Volume checkout -> Pi Worker -> Cube Tools
       -> trusted Volume commit/push -> GitHub Pull Request / Issue comment

GitLab project token -> encrypted project connection -> signed Project Webhook
       -> pending Issue request
GitLab OIDC user -> non-exclusive claim -> explicit execution selection
       -> ordinary Project / Workspace / Session / Run
       -> trusted Volume commit/push -> GitLab Merge Request / Issue note
```

The platform GitHub App private key and Webhook secret are deployment secrets.
PostgreSQL stores installation and repository identities, never installation
access tokens. The adapter mints a token for one repository and the minimum
permissions immediately before an API or Git operation.

Private checkout and push run in the trusted Workspace Volume Gateway against
the external Git directory. The token is supplied only to that bounded Git
child process and is absent from:

- Pi model context and SessionStorage;
- Candidate/Accepted Facts and Kafka;
- the Workspace file tree;
- Cube, Tool Worker and general Bash environments;
- command arguments, Tool output and logs.

Issue execution is explicit. A repository may opt into a deployment-owned
label (default `picloud`) and trusted collaborators may use the exact comment
command `/picloud solve`. Merely opening an Issue never consumes model quota.
GitHub delivery IDs are unique input keys. Branch, Pull Request and comment
effects have stable job identities and are reconciled after uncertain network
outcomes instead of being blindly repeated.

GitLab uses a project access token with `api`, `read_repository` and
`write_repository` scopes. PiCloud encrypts it with a source-control credential
master key. Connection creates or reconciles one project Webhook using GitLab's
Standard Webhooks signing-token contract. Comment triggers additionally verify
that the actor is a Developer or higher. The plaintext token follows the same
trusted-process-only boundary as a GitHub installation token.

The default login remains PiCloud-local and GitLab is optional. When configured,
GitLab OpenID Connect is a second authentication provider for one deployment-
selected PiCloud tenant. The authorization-code flow uses discovery, PKCE,
nonce and one-use state. The OAuth access token is discarded after resolving
the GitLab user; PostgreSQL keeps only the provider subject and public profile.
Deployments with split-horizon networking may configure a distinct trusted
GitLab API/Git origin. The public provider origin remains the OIDC/Webhook
identity; only trusted outbound requests and stored clone URLs are rewritten.

A GitLab Webhook creates an `awaiting_claim` Issue request and never starts a
model call. Any matching GitLab user with current Developer-or-higher project
membership may add or remove a non-exclusive human claim. Claims are an
idempotent expression of intent, not a scheduler lock and not an Agent
ExecutionLease. A claimant explicitly starts the request by choosing either a
new Issue-dedicated elastic Workspace/profile or an empty directory under
`/home/user` in one owned running cloud development machine.

Trusted Git metadata is keyed by the selected directory inside the persistent
Volume. This lets one owned development machine hold several repositories
without exposing `.git` metadata or a GitLab credential to Cube. The resulting
Session records its initiating PiCloud user. Delivery is always a Merge Request
containing `Closes #N`; the Agent cannot close the Issue or obtain GitLab API
authority through Bash.

The Issue coordinator is not a scheduler. It creates and observes ordinary
PiCloud Runs; the shared PostgreSQL Run queue remains the only Agent execution
queue.

## Alternatives

- A personal access token was rejected because it is user-wide and difficult
  to scope and rotate safely; GitLab uses a project-scoped bot token instead.
- Passing an installation token through Tool RPC was rejected because a Cube
  owner can inspect guest process memory and environment.
- Reintroducing the old repository importer was rejected because it mixed
  source acquisition, Workspace lifetime and GitHub delivery into one protocol.
- Flattening GitHub App and GitLab project authentication into one token model
  was rejected. The domain is provider-neutral, but each adapter preserves its
  native grant, Webhook and Pull/Merge Request semantics.

## Consequences

Both providers are optional. A deployment without either adapter retains the
empty/sample Workspace behavior. GitLab can be accepted locally with the pinned
CE lab deployment; live GitHub acceptance still requires an operator to
register the App and a user or organization owner to install it once.
