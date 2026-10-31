---
name: workspace-readiness
description: Inspect a coding Workspace before starting implementation, report the detected project files, and choose relevant validation commands.
compatibility: The optional inspection script uses Node.js in a Linux Workspace.
---

# Workspace readiness

1. Read the user's request and the repository instructions before changing files.
2. When file inspection is useful, prepare this package and run
   `node <prepared-skill-directory>/scripts/inspect.mjs` with the repository as
   the current working directory. This script only reads top-level file metadata.
3. Use the detected manifest to inspect the project's actual test/build commands.
   Consult `references/verification.md` for the checklist.
4. Report concrete findings. Do not claim a build or test passed unless you ran it.

For questions that do not require a Workspace, the instructions alone are sufficient.
