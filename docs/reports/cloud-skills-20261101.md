# Cloud Skill runtime delivery — 2026-11-01

Delivered as `cloud-skills-20261101-r5`, source `b891ab2c`, schema
`207_skill_runtime_metadata`, Helm revision 140. Code commits are pushed to main.
[Sanitized evidence](cloud-skills-20261101.evidence.json).

## Behavior and ownership

Installed names, descriptions and version references now appear in Pi's native
system section before model sampling. Instruction bodies and textual references
load on demand from the existing cloud package store, without allocating a VM.
Activating a package with scripts/templates/assets prepares its execution files
through the existing Workspace binding. Ordinary Sandbox Tools execute scripts;
the public `prepare_skill` step is removed.

The model normally calls `read_skill(action="read", name=...)`. The platform
resolves the name against the Run's immutable selection. An explicit version ID
can disambiguate duplicate names; conflicting selectors fail. During real model
acceptance, UUID-only invocation led Luna to reuse and mistype an old ID despite
a correct new system section. Name-based selection removed that avoidable burden;
the final check read the new version's marker using the same Skill name.

PG retains scoped installations and Run version references. S3 retains immutable
packages. Worker memory holds only metadata; native committed system entries
record what the model saw. Child grants filter discovery, and recovery reuses the
same Run selection. Installation changes take effect on the next Run, not halfway
through running work. Admission adds two SQL exchanges for the frozen selection
and its metadata; it adds no per-model database lookup or package fetch.

Agents author ordinary Workspace files and use `publish_skill` to share a complete
package inside the organization. A fixed guest reader exports bounded regular file
bytes over the existing private file channel, without Tool-output truncation or
package bodies in Kafka. Publication reuses the existing inventory/S3 service and
content deduplication. It does not auto-install. `inspect_skill` supports metadata
lookup and previews after an uncertain publication; unsafe effects are not replayed.
Publication uses the Session's owning user with member-level package authority,
not authority supplied in Tool arguments or an organization-wide installation grant.

The Skills page's Create action opens an editable chat request and preserves the
draft. Local directory/file-package import remains available. No public registry,
MCP server, extra scheduler, executable Worker extension or Pi core patch was added.

## Verification

- Whole-workspace run: 2363 passed, 5 failed, 11 skipped. The failures covered stale
  stage/SQL/schema expectations, the startup fixture's new initialization boundary,
  and an earlier cached publication implementation during that run. All five were
  corrected and passed fresh targeted rechecks. Logs retain the original failures;
  this is not presented as an initially green invocation.
- The final name-resolution change passed 18 focused tests, including real Pi
  system-section persistence/recovery, Worker environment selection, ambiguity,
  scoped PG selection and publication. All-workspace types and build passed.
- The 383 deterministic fault cases passed. That run began from the uncommitted
  feature worktree; it is not described as a clean-revision or live-chaos result.
- Browser checks covered the composer creation request, draft retention, local
  imports and organization management. Live owner/member sharing, preview,
  installation and version retention passed on r4; UI code is unchanged in r5.
- Five real Luna Runs on r5 passed: initial automatic discovery with no VM,
  automatic files plus Bash, new-version reading, Agent-authored publication,
  and inspection plus identical-content republication. No failed Tool results.
- Live consume, Stop, Worker recovery, streaming Stop and combined Worker/Control
  Plane crash recovery passed on r5. The intentional Control Plane SIGKILL produced
  a transient kubectl connection error; exit/restart and continuation were verified.
- Maintained dependency, documentation, runtime-policy, installation, Helm,
  observability, image closure/context, Cube and transport checks passed. All 13
  matched artifacts passed the configured scan and publication gates.

## Preservation and limits

Both matched cutovers closed old allocation admission and confirmed physical
absence before retiring ownership. Workspace Volumes and desired machine intent
were retained. Strict comparisons preserved all 6006 Workspace files, 150 images,
18 protected relations and 27 configuration/credential files. Both original
machines recovered and their final allocations survived the recovery checks.
Fresh inventories found no running applications, so none were invented/restarted.
All owned acceptance tenants, objects and compute were cleaned; final state has
29/29 running Pods ready and no active Runs, writers, bindings or elastic fixtures.

Mid-Run Skill reload, automatic project-directory discovery and external-market
synchronization remain outside this slice. The owner's deferred 131 MiB cold-image
request was not repeated. See [Skills](../SKILLS.md) and
[ADR-0293](../adr/0293-cloud-skill-runtime.md).
