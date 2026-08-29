# User-directed GitLab Issue Run acceptance

- Revision: `6603b5c`
- Checked at: 2026-08-29
- Topology: one-host PiCloud Compose, GitLab CE 19.3.0, CubeSandbox KVM
- Model: DeepSeek `deepseek-v4-flash`

GitLab Issue `#2` was triggered with the `picloud` label, claimed through the
matching GitLab OIDC identity and started with a user-supplied conversation
title. The request selected an existing empty elastic Workspace rather than an
Issue-dedicated Workspace. PostgreSQL retained that exact Workspace and title
through asynchronous coordinator provisioning.

The real-model Run created `version_info.py`, two passing tests, `.gitignore`
and README instructions. The resulting worktree had four uncommitted paths.
There was no remote task branch, Merge Request, Issue completion/failure note or
Issue state change; GitLab still reported the Issue as `opened`. This proves the
initial Issue Run only implements and tests, leaving commit, push and provider
delivery to a later explicit user instruction.

| Metric | Observed |
| --- | ---: |
| input tokens | 3,274 |
| output tokens | 1,471 |
| cache-read tokens | 100,736 |
| tests | 2 passed |
| uncommitted worktree paths | 4 |
| remote task branches | 0 |
| Merge Requests | 0 |

Migration 110 removed the obsolete `publishing`, change-request URL and Issue
completion-comment state while adding the bounded user-selected Session title.
The acceptance Session and Workspace are intentionally retained for UI review.
