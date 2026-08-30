# ADR-0137: Decouple identity, Issue intake, and Code Host connections

## Status

Accepted.

## Context

PiCloud previously coupled provider identity to Issue claims and stored one
repository-specific Git credential in the selected Workspace. That coupled
three independent concerns: authenticating to PiCloud,
receiving project Issue events, and authenticating Git inside an execution
environment. The single credential was also overwritten when another repository
was authorized.

## Decision

PiCloud identity, project integration, and environment Git authentication are
independent:

- PiCloud local login authenticates the user. Issue claims use that PiCloud
  identity only.
- A deployment-managed project connection and signed Webhook ingest Issue
  events for a tenant. Its credential never enters a user environment.
- Each elastic Workspace or exclusive development machine owns zero or more
  Code Host connections keyed by `(provider, origin)`. GitLab and GitHub HTTPS
  tokens are written directly to that persistent environment and never stored
  in PostgreSQL, Kafka, Pi Session state, or model context.

The environment uses Git's normal host-level credential semantics
(`credential.useHttpPath=false`). One connection can therefore authenticate any
repository on that origin that the token is allowed to access. Before an Issue
Run starts, PiCloud verifies the selected environment's origin credential with
`git ls-remote` against the exact repository. A missing, expired, or
underprivileged credential must be replaced through the Code Host connection
dialog.

Blank Workspaces contain neither `.git` nor a credential file. `.git` remains
ordinary user/Agent repository state created only by `git clone` or `git init`.
The environment credential store is the single hidden `.git-credentials` file;
the retired `.pi-cloud-home` directory is not supported.

## Consequences

- PiCloud users can claim tenant-visible Issue tasks without a GitLab identity
  mapping or a per-claim GitLab membership query.
- Arbitrary GitLab origins and `https://github.com` can be connected with an
  appropriately scoped token.
- Project Webhook/API credentials and environment Git credentials have separate
  lifecycles and blast radii.
- Credentials are intentionally readable by untrusted code in the environment
  that owns them, matching an ordinary developer machine threat model.
