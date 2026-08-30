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
variables needed for the project connector, Webhook route, Agent-visible Git origin
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

When testing Agent-side push from Cube, bind this lab to a deployment-owned
private address and set `PI_CLOUD_GITLAB_WORKSPACE_BASE_URL` to that address.
The matching `/24` must be present in
`PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS`. This split route is only for the
local lab; a production GitLab URL should already be reachable from Cube.

Open `http://gitlab.localhost:8929` and sign in as `root`. Create a public or
private project, then create a project access token with Maintainer role and
the `api`, `read_repository` and `write_repository` scopes. Connect it through
`POST /v1/source-control/gitlab/projects` under the intended PiCloud tenant.
The resource page intentionally has no project-token form; it only shows Issue
tasks created by configured Webhooks.

The connector registers a signed Issue/Note Webhook automatically. Add the
`picloud` label to an Issue or post `/picloud solve` as a Developer or higher;
PiCloud records a pending Issue request. An authorized PiCloud tenant user may
claim it, choose elastic or owned-machine execution, and name the Session.
PiCloud checks the selected environment with `git ls-remote`; missing
credentials open the Code Host connection dialog. A scoped user token is
written directly to that environment's `.git-credentials`, and the Agent
performs `git clone`. The initial
Run changes and tests files only; commit, push, Merge Request and Issue state
remain explicit later user actions.

GitLab state and its generated root password live under ignored
`deploy/gitlab/runtime/`. Stop it with `npm run gitlab:down`.
