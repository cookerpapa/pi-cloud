# GitLab OIDC and Issue workflow acceptance

- Revision: `869b0bb1670a94b901dfb3c4294bd3dfb2f94353`
- Checked at: 2026-08-29T06:50:44.070Z
- Topology: one-host PiCloud Compose, GitLab CE 19.3.0, CubeSandbox KVM
- Model: DeepSeek `deepseek-v4-flash`

The real browser-facing OIDC flow completed through GitLab authorization code,
PKCE, nonce and one-use state. The resulting PiCloud identity retained the
GitLab subject/user ID but no OAuth access token. A private project was connected
with an encrypted project token and its signed Webhook created an
`awaiting_claim` request without starting a Run. The matching GitLab user
claimed it after a live project-membership check; the claim was projected back
to the GitLab Issue.

Two token-consuming coding tasks completed end to end:

| Mode | Job elapsed | Run elapsed | Input / output / cache-read tokens | Result |
| --- | ---: | ---: | ---: | --- |
| Elastic Workspace (`starter`) | 34.519 s | 23.556 s | 2,800 / 1,886 / 56,320 | private checkout, Cube tests, branch and MR |
| Owned development machine | 28.091 s | 21.816 s | 8,604 / 1,597 / 59,392 | directory checkout at `/home/user/issue-counting-sort`, Cube tests, branch and MR |

Both Merge Requests contained `Closes #N`. Git metadata and credentials stayed
in the trusted Volume/API boundary. The owned machine remained running after
the Agent Run, and its selected directory contained the repository and generated
tests. The acceptance project, Issue jobs, temporary Workspaces, machine,
Volumes and plaintext test credentials were removed after evidence capture.
