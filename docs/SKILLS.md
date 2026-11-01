# Skill market

The sidebar's **Skills** page is an organization-only catalog of reusable
workflows. Browse shared packages or switch to Installed; search reads catalog
metadata one bounded page at a time until it finds a match. It does not fetch
package bodies or query any external registry. Use the pager for further results.

A list item shows its name, purpose and install state. Details load SKILL.md and
supporting files on demand; version, scope, requirements and management actions
live there. New versions never silently replace another member's installation.

Share by writing SKILL.md, choosing a local directory or importing an exported
`.skill.json` file package. Updating instructions retains supporting files.
The Web page offers no public catalog or GitHub import. Existing GitHub provenance
and the operator import API remain available; this presentation slice does not
alter stored packages or the wire schema.

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
During a Run, availability follows its accepted file/shell grants, native child
scope and current execution-side Tool catalog. A read-only child does not gain
Bash/write through a Skill; a child without a Workspace can still read pure
instructions. Max versus Ultra changes delegation policy, not whether an explicitly
requested delegation Tool exists. The market page describes deployment capabilities;
`read_skill` checks the actual Conversation.

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

Guest placement uses an OS-held lock and managed staging under
`<Workspace>/.pi-cloud/skill-staging/`. A bounded filesystem receipt precedes
partial files; individual files and the final package are published by rename.
The next preparation reclaims verified abandoned staging after a killed process.
Active preparations are excluded by the lock; changed/unrecognized staged content
is preserved with an error for inspection. Completed package directories are
outside the staging reaper and remain user Workspace bytes.

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
