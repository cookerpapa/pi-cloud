# Workspace-owned GitLab Issue Run acceptance

- Revision: `6d69c0f`
- Checked at: 2026-08-30
- Topology: one-host PiCloud Compose, GitLab CE 19.3.0, CubeSandbox KVM
- Model: DeepSeek `deepseek-v4-flash`

GitLab Issue `#5` was triggered with the `picloud` label, claimed through the
matching GitLab OIDC identity and assigned to a newly-created empty elastic
Workspace. The first real `git ls-remote` returned `credential_missing`. A
separate OAuth authorization used PKCE and one-use state, returned to the Issue
resource page, and wrote the user credential directly to the selected
Workspace's hidden `.pi-cloud-home`. The next preflight succeeded.

PiCloud did not clone the repository. The Pi transcript shows the Agent first
listing the empty Workspace, then issuing ordinary `git clone` against the
credential-free Cube-reachable URL. The resulting remote contains no userinfo.
The Agent created a task branch, implemented `binary_search.py`, added nine
passing tests and left four worktree paths uncommitted. GitLab still reported
the Issue as open with no remote task branch or Issue-specific Merge Request.

The hidden Git Home was absent from the Workspace file index. A parameterized
scan of all 326 PostgreSQL text, character and JSON columns found no occurrence
of the OAuth token. PostgreSQL stores only consumed one-use OAuth state/PKCE
metadata; the token remains Workspace-owned and deliberately visible to that
Workspace's Agent.

| Metric | Observed |
| --- | ---: |
| input tokens | 5,812 |
| output tokens | 3,094 |
| cache-read tokens | 173,952 |
| tests | 9 passed |
| uncommitted worktree paths | 4 |
| remote task branches | 0 |
| Issue-specific Merge Requests | 0 |
| PostgreSQL credential matches | 0 / 326 scanned columns |

The acceptance also revalidated a credential after Git's `credential-store`
normalized the explicit port as `%3A`, rotated the deployment project token and
removed authenticated remote URLs left by the retired platform-clone path. The
Issue `#4` and `#5` Sessions and Workspaces remain available for UI review.
