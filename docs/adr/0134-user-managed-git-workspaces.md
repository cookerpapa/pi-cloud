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
user or source bootstrap. The Agent may inspect, change, print or remove them.
PiCloud does not claim that a Workspace protects its own credentials from the
Agent.

PiCloud removes:

- the external Git baseline and source-binding directories;
- per-Run Workspace Patch generation and Patch artifacts;
- Workspace Patch fields from events, command results and Web resources;
- platform post-Run commit and push behavior;
- isolated-Subagent Patch extraction.

The persistent Cube Volume remains the Workspace byte authority. Its bounded
file/hash catalog exists only to support checkpoint identity and the source
browser; it is not compared into a user-visible change set. Root `.git` is
preserved in the Volume but omitted from that catalog and browser listing.

An optional repository bootstrap may clone a connected repository into an
empty Workspace. It leaves a standard `.git` directory and a usable remote in
the guest. This is initialization, not a second Git authority. Background
Issue Runs receive an ordinary branch and must commit and push it themselves.
After the Run settles, the trusted provider adapter may create a Merge/Pull
Request from that already-pushed branch; it never inspects Workspace changes or
creates a commit.

## Consequences

- Agent behavior matches a normal Linux development machine.
- Credentials stored by `glab`, Git or the bootstrap are intentionally visible
  to untrusted code and disappear only with their configured environment or
  Workspace lifetime.
- Prompt injection can exfiltrate repository credentials; deployments must
  treat this as an explicit user-authorized risk.
- A background Issue Run fails delivery if the Agent does not produce and push
  a branch.
- Isolated Subagents return their semantic result and independent Workspace;
  users or Agents coordinate Git branches instead of receiving a platform Diff.
