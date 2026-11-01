# Skill market

The sidebar's **Skills** page is an organization-only catalog of reusable
workflows. Browse shared packages or switch to Installed; search reads catalog
metadata one bounded page at a time until it finds a match. It does not fetch
package bodies or query any external registry. Use the pager for further results.

A list item shows its name, purpose and install state. Details load SKILL.md and
supporting files on demand; version, scope, requirements and management actions
live there. New versions never silently replace another member's installation.

Use **Create Skill** to put an editable request in the chat composer. The Agent
writes SKILL.md and any supporting files in the Workspace, checks the workflow,
and calls `publish_skill`. The shortcut preserves an existing draft and does not
send automatically. **Import** accepts a local directory or exported `.skill.json`
package; it is not a manual YAML editor. Existing GitHub provenance and the
operator import API remain, but the Web has no public registry or GitHub import.

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

At authorized Run bootstrap, the runtime pins the installed version selection in
PG and sends immutable metadata to the Worker. Pi's public system section presents
applicable names, descriptions and version references before the first model
request. It does not include every Skill body. `disable-model-invocation: true`
hides a Skill from automatic discovery; explicit inspection remains possible.

Three code-owned Tools use the existing execution-owned catalog:

- `read_skill(action="read", name=...)` resolves the advertised name to its frozen
  version and reads SKILL.md without
  a preliminary list call. For duplicate names, inspect the list and provide
  `versionId` to disambiguate; ordinary use does not require copying UUIDs. `path` reads a package-relative reference; text, file
  lists and prerequisites have continuation offsets. `action="list"` remains for
  explicit inspection. Pure instructions and textual references come directly
  from cloud storage without a VM.
- On activation, a package with scripts, assets or other execution files is
  automatically prepared under `<Workspace>/.pi-cloud/skills/<name>-<digest>/`.
  The read result includes this directory. Use ordinary `bash`/`read` afterwards;
  there is no separate model-facing `prepare_skill`. Preparation neither executes
  scripts nor grants permissions. Existing modified package files are not
  overwritten. Use `inspect_skill` for a preview without activation.
- `publish_skill(path, packageId?, version?, requirements?)` exports complete file
  bytes through the fixed guest transport and publishes an immutable organization
  version. It never reconstructs files from truncated Bash output. Only root
  Conversations can publish, as the Session owner with member-level package authority. Without explicit
  requirements, scripts imply Linux/Bash; declare other dependencies as needed.
  Omitted version labels derive from content. Publishing does not install or
  upgrade the Skill for anyone.
- `inspect_skill(name?, cursor?)` lists published organization metadata and marks
  owned packages. `versionId` with optional `path`/`offset` previews text, including
  uninstalled versions, without activation. Use this after an uncertain publication
  reply before deciding to retry. Identical content reuses the existing version.

Child Conversations share the root Run's selection and filter it by their own
capabilities. Worker recovery reads that same selection. Installing, disabling or
updating a Skill affects the next Run, not a running task. Instructions already
read remain ordinary Tool Results. Native system entries record the catalog the
model saw. This does not add an input queue, scheduler or per-model PG query.
Mid-Run `/reload` and local project-directory Skill scanning are not provided.

Conditional Skill preparation resolves against frozen metadata and uses ordinary
Tool admission and the existing Workspace binding. Kafka carries Tool intents and
normal replies, not the complete package transfer. Worker Harness processing
still makes the final Tool Result canonical.

## Storage and failure

PG owns `skill_packages`, `skill_versions`, `skill_installations` and
`run_skill_catalogs`. The latter contains immutable version IDs, not file bodies. Published versions
also retain derived discovery/resource metadata; startup backfills it from the
verified immutable object before accepting work.
Package bytes use the existing S3 service under `skills/<tenant>/<digest>.json`.
They are separately inventoried from images and Workspace Volumes. The import
inventory precedes object writes; a version is visible only after confirmation.
Retrying the same package resumes that identity. Object loss or digest mismatch
is an error, never an excuse to execute a different package.

Publication exports at most 512 regular files / 16 MiB through the fixed guest
reader. It rejects missing manifests, links, changed source files and overlarge
packages with actionable errors. Cancellation cannot return a successful export;
an uncertain publish is inspected rather than automatically replayed. Package
bytes travel over the existing private file channel, never through Kafka.

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
See [ADR-0291](adr/0291-internal-skill-market.md),
[ADR-0293](adr/0293-cloud-skill-runtime.md) and the portable
[example](../examples/skills/workspace-readiness/SKILL.md).

## Verification

Run the focused Skill package/PG/guest tests, `node
scripts/run-skill-market-browser-check.mjs`, and the maintained matched release.
Real acceptance must demonstrate both instruction reading without VM activation
and automatic preparation plus ordinary script execution in Cube, initial prompt
discovery, immutable Run selection, complete Agent publication and uncertain-reply
inspection using owned fixtures.
