# ADR-0293: Cloud Skill discovery, activation and publication

Status: implementation authorized, 2026-11-01. Supersedes ADR-0291's first-use
catalog selection and explicit prepare_skill model workflow.

## Decision and boundaries

Keep organization installations and immutable published packages in existing PG
and S3. No public registries, MCP server, second scheduler or alternate executor.
Pin the installed version selection during authorized Run bootstrap, before the
first model request. Workers receive only immutable metadata and version references;
Pi's public system section renders stable names/descriptions/read references. The
native committed system entries record what the model saw. Recovery uses the same
Run selection; children filter it against their own current tool grants. There is
no per-model-request catalog database scan and no Skill body in queue rows.

Use a small Skill-aware environment resolver at the trusted preparation boundary:
a Skill activation with execution resources needs the existing Workspace binding,
while instructions and textual references do not. This is a declared environment
requirement in the execution-owned tool catalog, resolved against the frozen Skill
metadata, not a handler moved into the Worker or an agent-loop modification.
Future Skill packages require no Worker code changes. Missing/inconsistent metadata
fails before effects rather than guessing permissions or switching versions.

read_skill activates a known version directly. Instructions without execution
resources return from cloud storage without a VM. An activation with scripts,
assets or other execution files uses the current binding and the existing fixed
package placement path, then returns the actual directory alongside instructions.
The model uses ordinary read/bash afterwards. Textual references remain cloud
readable. Remove the public prepare_skill tool; retain package placement as an
internal executor operation. Installation never copies every package into a VM.
The activation is conservatively non-replayable when its files may have been
written; canonical committed results and native interruption semantics are retained.

Agent creation uses ordinary Workspace tools. publish_skill reads a bounded,
complete directory through a fixed guest file-export operation and reuses the
existing package publication service. It does not reconstruct files from truncated
Tool output, execute scripts in the Control Plane/Worker, or send package bodies
through Kafka. Publishing uses the originating user's organization and permissions;
new versions do not install themselves for other users. Immutable content dedup and
organization metadata lookup support uncertain publication without a Tool ledger.
Unsafe publication is never automatically rerun after a crash.

The Web creation shortcut returns an editable request to the composer without
sending it or replacing a newer draft. Retain local file import; remove manual
instruction editing from the primary sharing workflow. Existing files, versions,
installations, accounts and configuration remain owned by their current stores.

## Adopt before build

- Rivet Agents documents public Pi sections plus a read tool backed by worker
  files or a database: https://rivet.dev/agents/docs/skills/ . Adopt that composition,
  not the Actor storage authority.
- Cloudflare separates Skill sources from activation/resources and script
  execution: https://developers.cloudflare.com/agents/skills/ and
  https://developers.cloudflare.com/agents/skills/execution/ . Its experimental
  Dynamic Worker runner is not a replacement for Cube execution.
- OpenAI documents cloud version references and sandbox-visible resources:
  https://developers.openai.com/api/docs/guides/tools-skills . Claude documents
  versioned managed skills and file-based use:
  https://platform.claude.com/docs/en/managed-agents/skills . These public contracts
  do not establish their internal physical-copy implementation.

Reuse the pinned Pi 1.0 public APIs and existing package/file transport. No native
upgrade or vendor runtime adoption is necessary. Keep content-addressed versions,
scoped installation revisions, writer fencing and Cube's execution ownership.

## Acceptance

Prove initial catalog visibility without a discovery Tool call, lazy body loading,
text-only use without a VM, automatic execution-resource placement, and normal
Bash execution. Verify child grants, version pinning, mid-Run installation edits,
Worker recovery, same-content publication, source export bounds/change detection,
missing files, cancellation and uncertain outcomes. Verify owner/member Web flows
and draft preservation. Use Luna for model acceptance; no deferred 131 MiB probe.
Publish matched artifacts after draining/sealing and preserve user assets.
