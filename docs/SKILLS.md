# Skill market

The sidebar's **Skills** page is a tenant-local catalog of reusable workflows.
Publish `SKILL.md` directly, import a local directory containing it, or import a
public GitHub repository directory at a branch, tag or commit. Git references
resolve to a fixed commit. Imports preserve `scripts/`, `references/` and assets.
Exported `.skill.json` packages can be imported in the same publisher form.

Install a specific version for yourself. Tenant owners may also install for the
organization or the selected conversation's project. Precedence is project,
personal, organization; an explicitly disabled nearer installation masks a wider
one. Updating a published package creates an immutable version; installations do
not silently upgrade. Readers cannot publish or change installations.

`compatibility` in SKILL.md is human-readable guidance. The form separately records
required Tool names, runtime (`none`, `linux`, `android`) and software prerequisites.
Unsupported capabilities and unverified software are shown separately. Software
is checked/installed by ordinary Sandbox work when needed, not executed on import.
The Android label describes a requirement and does not enable a phone runtime.

## Agent use

Two code-owned Tools are added through the existing execution-owned catalog:

- `read_skill(action="list")` discovers installed names, descriptions, version IDs
  and compatibility. `read_skill(action="read", versionId=...)` reads SKILL.md;
  `path` selects a relative package file. Text, file-directory and prerequisite
  pages have explicit continuation offsets. Binary assets require preparation.
- `prepare_skill(versionId=...)` places a selected package under
  `<Workspace>/.pi-cloud/skills/<name>-<digest>/` and returns that real directory.
  Use ordinary `bash`, `read` and other granted tools afterwards. Preparation does
  not run scripts, install dependencies, or grant tools/credentials. Invoke scripts
  with their interpreter. Existing modified package files are not overwritten.

The first Skill use captures that Run's selected versions in PG. Child
Conversations use the same root Run selection. Recovery reads that selection;
later updates, disable or uninstall affect subsequent Runs. Instructions already
read remain ordinary Tool Results in context. This is configuration pinning, not
a second input queue or another Agent scheduler.

Pure instruction reading does not start a VM. File preparation follows ordinary
Tool admission, the current Sandbox binding and the fixed guest file transport.
Kafka carries the Tool intent/version reference and the usual final reply, not the
package body. Worker Harness processing still makes the result canonical.

## Storage and failure

PG owns `skill_packages`, `skill_versions`, `skill_installations` and
`run_skill_catalogs`. The latter contains immutable version IDs, not file bodies.
Package bytes use the existing S3 service under `skills/<tenant>/<digest>.json`.
They are separately inventoried from images and Workspace Volumes. The import
inventory precedes object writes; a version is visible only after confirmation.
Retrying the same package resumes that identity. Object loss or digest mismatch
is an error, never an excuse to execute a different package.

The import/placement envelope is 512 regular files and 16 MiB decoded package
content (24 MiB encoded). These bounds contain parser/transport memory; they do
not change conversation upload quotas. Move large datasets out of the Skill.
Published versions are retained for pinned Runs; this first slice has no public
package/version deletion or automatic external registry synchronization.

Public routes: `GET /v1/skills?projectId=&cursor=`, binary-JSON
`POST /v1/skills/imports`, `PUT|DELETE /v1/skills/:id/installation`, and
`GET /v1/skills/versions/:id/files`. The installation body includes scope,
versionId, enabled and the current revision (`null` for a new installation).
Shared changes and package updates are ownership checked. Source imports never
load executable extensions in the Control Plane or Worker.

Automatic repository scanning, private Git registry credentials, dependency
resolution and arbitrary user Tool hosting remain separate proposals.
See [ADR-0291](adr/0291-internal-skill-market.md) and the portable
[example](../examples/skills/workspace-readiness/SKILL.md).

## Verification

Run the focused Skill package/PG/guest tests, `node
scripts/run-skill-market-browser-check.mjs`, and the maintained matched release.
Real acceptance must demonstrate both instruction reading without VM activation
and preparation plus ordinary script execution in Cube, using an owned fixture.
