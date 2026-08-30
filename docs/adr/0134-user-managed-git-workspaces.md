# 0134 — User-managed Git Workspaces

## Status

Accepted.

## Context

PiCloud previously maintained an external Git directory beside every persistent
Workspace. It used that hidden repository to hash the complete file tree,
produce a per-Run unified Diff, create Patch artifacts and perform post-Run
commit/push operations. This supported an earlier structured-Diff and review
product direction that is no longer part of the Web product.

The hidden repository also made an ordinary cloud development environment
behave unlike Git: an Agent could not reliably use `git status`, `git log`,
credential helpers or `glab` against the repository it was editing.

## Decision

Git is user-managed state inside the Workspace. A repository-backed Workspace
contains its ordinary `.git` directory and any credentials configured by the
user or the explicit Workspace authorization flow. The Agent may inspect,
change, print or remove them.
PiCloud does not claim that a Workspace protects its own credentials from the
Agent.

PiCloud removes:

- the external Git baseline and source-binding directories;
- per-Run Workspace Patch generation and Patch artifacts;
- Workspace Patch fields from events, command results and Web resources;
- platform post-Run commit and push behavior;
- isolated-Subagent Patch extraction.

The persistent Cube Volume remains the Workspace byte authority. Run settlement
records only the provider Volume revision; source browsing lists and reads the
live Volume without building a catalog. Root `.git` is preserved in the Volume
but omitted from the product browser.

PiCloud never bootstraps a repository. A selected environment must pass a
credential preflight; the Agent then performs ordinary `git clone` and branch
commands. Background Issue Runs leave commit, push, provider delivery and Issue
state to a later explicit user instruction. The platform never inspects
Workspace changes or creates a commit.

## Consequences

- Agent behavior matches a normal Linux development machine.
- Credentials stored by GitLab OAuth, `glab` or Git are intentionally visible
  to untrusted code and disappear only with their configured environment or
  Workspace lifetime.
- Prompt injection can exfiltrate repository credentials; deployments must
  treat this as an explicit user-authorized risk.
- The initial Issue Run produces only Workspace changes and test evidence;
  commit, push and provider delivery require a later explicit instruction.
- Isolated Subagents return their semantic result and independent Workspace;
  users or Agents coordinate Git branches instead of receiving a platform Diff.
