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

PiCloud owns a provider-neutral source-control domain and ships a GitHub App
adapter first.

```text
Browser -> GitHub App install -> PiCloud installation/repository grants

GitHub Webhook -> HMAC gate -> idempotent Issue Job
       -> ordinary Project / Workspace / Session / Run
       -> trusted Volume checkout -> Pi Worker -> Cube Tools
       -> trusted Volume commit/push -> GitHub Pull Request / Issue comment
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

The Issue coordinator is not a scheduler. It creates and observes ordinary
PiCloud Runs; the shared PostgreSQL Run queue remains the only Agent execution
queue.

## Alternatives

- A personal access token was rejected because it is long-lived, user-wide and
  difficult to scope and rotate safely.
- Passing an installation token through Tool RPC was rejected because a Cube
  owner can inspect guest process memory and environment.
- Reintroducing the old repository importer was rejected because it mixed
  source acquisition, Workspace lifetime and GitHub delivery into one protocol.
- Implementing GitLab in the first slice was rejected. The domain port is
  provider-neutral, while each provider keeps its native installation and
  token semantics.

## Consequences

GitHub App setup is optional. A deployment without App credentials retains the
current empty/sample Workspace behavior. A live GitHub acceptance test requires
an operator to register the App and a user or organization owner to install it
once.
