# ADR-0291: Versioned Skills with environment requirements

Status: accepted for implementation, 2026-10-31.

## Decision

Provide a tenant-local Skill market. A Skill is an Agent Skills directory containing
`SKILL.md` and optional references, scripts and assets. It is not a dynamically
loaded Worker extension. Users may publish a directory package or import a public
GitHub directory at a resolved commit, browse versions, install a version for
themselves, their tenant or a project, disable it, and explicitly update it.
Shared installations require tenant-owner authority. Personal installs are scoped
to the user who owns the conversation. Package updates require package ownership.

PG owns package/version metadata, scoped installations and immutable per-Run
version selections. Existing S3 storage owns content-addressed package bytes under
a separate Skill prefix. Do not store package bodies in queue rows, native history,
or the Worker filesystem. Unpublished imports remain inventoried and retryable;
only a confirmed object write permits publishing a version. Published versions
are immutable and remain available to Runs that selected them.

Use two fixed execution-owned tools: `read_skill` lists available Skills and reads
bounded instruction/reference pages without activating a Workspace;
`prepare_skill` copies a selected package into the already admitted Workspace.
It only places files; installation commands and scripts execute through ordinary
Sandbox Tools. Copying a package grants no new Tool, credential or network access.
The first Skill use freezes the installed version selection for that Run; later
installation changes affect subsequent Runs. Children resolve the same root
Run selection. Tool results retain version/source/digest provenance.

`compatibility` from SKILL.md remains human-readable guidance. PiCloud metadata
separately declares required Tool names, an optional runtime capability, and
software prerequisites. Unsupported runtime/Tools are distinguished from software
which may need installation or has not been checked. Do not infer capabilities
from a Cube ID or parse arbitrary prose as an executable policy. A text-only
Skill has no runtime requirement. Workspace copies are disposable execution copies,
not a second authority for Workspace bytes or marketplace package versions.

The market is an internal directory, not a public hosting service or arbitrary
Tool marketplace. Project-local packages can be imported through the same package
format. Automatic crawling of repositories and credentialed external registries
are outside this first slice. Explicit import and version selection provide a
complete usable path without another registry service or dependency solver.

## Adopt versus build

- [Agent Skills](https://agentskills.io/specification) supplies the portable
  directory/frontmatter and progressive disclosure conventions. Preserve these
  files rather than inventing an instruction format. Use the pinned YAML parser.
- [Vercel Skills](https://github.com/vercel-labs/skills) (MIT, inspected commit
  `92a9a34ac3bf88e695e468b90c7bf32f163d32c8`) tracks source, relative directory and
  content hash for explicit updates. Its local installer does not own tenant
  scopes, cloud Run snapshots or Sandbox placement, so reuse its conventions,
  not a competing installation authority.
- [Pi on Cloudflare](https://github.com/harshil1712/pi-on-cf) (MIT, inspected
  commit `e75d46cd04bbbdcff165892bc84e00f0b66c0d6b`) separates repository/object-store
  Skill sources and reading tools. Its shared Skill editing is not tenant-scoped.
- [Rivet Agents](https://rivet.dev/agents/docs/skills/) supports packaged and
  workspace Skills, but adopting its Actor runtime would introduce a competing
  runtime/storage authority. Keep PiCloud's existing PG/Kafka/Sandbox boundaries.

No new broker, workflow engine or marketplace daemon is needed. The bounded
catalog and package adapter integrate with the existing API, object store and
execution-owned Tool registry. Export is the original portable directory files
plus source, digest and requirements metadata.

## Acceptance

Verify import validation and idempotency, immutable versions, tenant/user/project
scope, enable/disable/update, active-Run pinning and retry after lost replies.
Demonstrate pure-text reading without a VM and script/resource placement followed
by ordinary Cube execution. Test cancellation and failed placement without
pretending it succeeded. Never execute package scripts on the API or Worker.
Verify the market in a browser and include it in matched-release acceptance.
