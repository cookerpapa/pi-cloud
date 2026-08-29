# Local GitLab acceptance instance

This optional deployment runs a pinned GitLab CE instance for PiCloud's
source-control acceptance tests. It is independent from the PiCloud production
Compose project and is not an HA or production GitLab topology.

```bash
npm run gitlab:up
npm run gitlab:password
npm run gitlab:oauth
```

`gitlab:oauth` creates a local OIDC application and prints the private-runtime
variables needed for the project connector, Webhook route, trusted Git origin
and **Continue with GitLab** login button.
Copy them into the ignored `deploy/production/runtime/.env`, set
`PI_CLOUD_OIDC_GITLAB_TENANT_ID` to the PiCloud tenant that owns the connected
project, and restart the Control Plane.

When the PiCloud Compose network already exists, `gitlab:up` also joins the
GitLab container to its trusted egress network under the `gitlab.localhost`
alias. This avoids routing local OAuth/API/Git traffic through the host or the
public proxy; production deployments use their normal routable GitLab origin.
The local PiCloud runtime exposes `control-plane.internal` on that network for
Webhook delivery; it is not a public deployment name.

Open `http://gitlab.localhost:8929` and sign in as `root`. Create a public or
private project, then create a project access token with Maintainer role and
the `api`, `read_repository` and `write_repository` scopes. In PiCloud, open
**开发资源 → GitLab** and connect the project using that URL, project path and
token.

The connector registers a signed Issue/Note Webhook automatically. Add the
`picloud` label to an Issue or post `/picloud solve` as a Developer or higher;
PiCloud records a pending Issue request. A user authenticated through this
GitLab instance and holding Developer access may claim it, choose elastic or
owned-machine execution, and start the ordinary Session/Run. The resulting
Workspace contains a normal authenticated Git worktree. The Agent commits and
pushes the job branch, after which PiCloud opens a Merge Request with
`Closes #N`.

GitLab state and its generated root password live under ignored
`deploy/gitlab/runtime/`. Stop it with `npm run gitlab:down`.
