---
name: workspace-readiness
description: Inspect a coding Workspace before starting implementation, report the detected project files, and choose relevant validation commands.
compatibility: The optional inspection script uses Node.js in a Linux Workspace.
---

# Workspace readiness

1. Read the user's request and the repository instructions before changing files.
2. When file inspection is useful, use the resource directory returned when
   activating this Skill and run `node <skill-directory>/scripts/inspect.mjs` with the repository as
   the current working directory. This script only reads top-level file metadata.
3. Use the detected manifest to inspect the project's actual test/build commands.
   Consult `references/verification.md` for the checklist.
4. Report concrete findings. Do not claim a build or test passed unless you ran it.

For an instruction-only preview, use inspect_skill; activating this execution Skill prepares its files in the Workspace.
