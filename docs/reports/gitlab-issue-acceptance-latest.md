# User-managed Git and GitLab Issue delivery acceptance

- Application revision: `63ee2892526b2baf675a1622aa87d5113eb97ae8`
- Schema cleanup revision: `ca0ba41`
- Checked at: 2026-08-29
- Topology: one-host PiCloud Compose, GitLab CE 19.3.0, CubeSandbox KVM
- Model: DeepSeek `deepseek-v4-flash`

A private GitLab project was connected to tuhao and initialized as an ordinary
Workspace Git worktree. The root `.git` directory and authenticated `origin`
were visible inside Cube. The first real-model Run modified `README.md`, ran a
verification, executed ordinary `git status/add/commit/push`, and settled with a
clean worktree. The remote branch SHA exactly matched the Workspace HEAD.

A second real-model Run used the unattended Issue coordinator. The Agent again
created and pushed its own commit. Only after the Run completed did PiCloud
create Merge Request `!1` from the already-pushed branch. The branch SHA matched
the Workspace HEAD, and no platform Patch artifact or commit identity was
created.

| Path | Input / output / cache-read tokens | Result |
| --- | ---: | --- |
| repository-backed conversation | 2,792 / 786 / 54,272 | Agent commit and push succeeded |
| background Issue Run | 1,429 / 988 / 58,368 | Agent push followed by platform MR |

Migration 109 left zero `workspacePatch` fields in terminal/outbox payloads,
zero Patch artifacts, and no `patch_artifact_id` or `commit_sha` columns. The
acceptance project, Issue/MR, repository connection, temporary Workspaces,
Volumes and plaintext test credentials were removed after evidence capture.

The GitLab OIDC authorization-code/PKCE/claim path was not rerun for this Git
ownership change; its most recent independent acceptance remains in Git
history at revision `869b0bb`.
