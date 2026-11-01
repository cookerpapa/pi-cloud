# November 1 repository repairs

Implements the owner-approved R01–R08 from the
[review](repository-review-20261101.md) under
[ADR-0292](../adr/0292-repository-boundary-repairs.md).
Matched `review-repairs-20261101` is deployed from
`53b2cd71dbc189ff39f2cb1790a810d1852542ab`, on schema 206 and platform Helm
revision 136. All 13 artifacts passed the maintained scan/provenance gate.
The later `082ae417` correction fixes only the native acceptance driver's runtime
path; serving binaries remain the matched revision. Owned Luna/Cube/browser,
Skill, Fork and native Stop/crash recovery acceptance passed.

[Machine-readable delivery evidence](review-repairs-20261101-evidence.json).

## Behavior

- **R01:** Sandbox owner loss permanently closes local admission, withdraws
  aggregate readiness and requests process retirement. A 30-second exit remains
  armed even if startup or cleanup hangs. Transient renewal failures before the
  confirmed deadline remain retryable. No VM absence is inferred.
- **R02:** Bootstrap is first-install only. Existing serving markers or Helm
  releases cause refusal before writes. The old public direct-deploy action is
  removed; the matched operator calls deployment internally after its existing
  lock, artifact, drain and physical-inventory gates. Uninstall is explicitly not
  a routine restart procedure. Matching builds cannot overwrite the serving
  catalog through the old default build path.
- **R03:** Fork/prune validate a single completed point through indexed native
  navigation and Turn metadata. The 10,000-node lifetime ceiling and navigation
  body scan are removed; bounded sidebar response limits remain. A larger
  regression also exposed a slow cold-retention join: non-entry metadata now
  joins write references directly rather than expanding shared entries and
  joining that view back to its references. Native IDs, original publication
  positions and document fork policies are unchanged.
- **R04:** Worker offering and Skill requirements use one effective capability
  resolver. It accounts for root/child role, accepted tools, depth and targets;
  max/Ultra remain delegation policies. Read-only children do not advertise shell
  workflows. Skills can express requirements against available runtime capabilities
  without granting a device or loading Worker extensions.
- **R05:** Terminal state reaches frozen reading pages through events and snapshot
  refresh, including during selection. Frozen stream fragments retain their text
  and rendering mode; they do not acquire complete-answer copy/Fork actions until
  canonical content replaces them. No history or server protocol changes.
- **R06:** CONNECT establishment remains bounded; its five-minute idle deadline
  follows actual traffic. Healthy active tunnels have no total lifetime cutoff.
  Establishment and idle timeouts have distinct audit reasons. This is Sandbox
  egress, not model-provider waiting.
- **R07:** Skill staging reuses the existing OS-lock area. A bounded receipt and
  atomic per-file publication let a later preparation identify abandoned partial
  work. Active staging is excluded; modified/unrecognized files are preserved for
  inspection. Final package directories never enter this reaper.
- **R08:** Maintained model-runtime/outage/native-input drivers compare source
  migrations, actual PG schema and the serving contract rather than stale migration
  literals. Required capabilities still fail closed. Current documentation drops
  duplicated serving claims and reconciles delivered backlog items. Native-body
  measurement observes actual results and proves that a real read hits the meter.

The matched manifest now includes the existing Cube egress gateway, whose source
change must actually be built, scanned and published for R06. It contains **13**
artifacts. The gateway is reconciled after Control Plane configuration becomes
available; its readiness cannot deadlock a cutover while the Control Plane is down.

## Focused verification and retained failures

The new controller, installation, capability, reading, egress and staging cases
pass. The full native conversation-tree suite passes 22 cases, including >10,000
navigation nodes, text-heavy history, active/nested Forks and independent pruning.
Browser geometry/selection checks include terminal events and a snapshot-only
cancelled state while reading. A real owned child process is killed before/after
file publication to verify staging recovery and exclusion.

Initial failures are retained in private evidence:

- One old ownership fixture manually revived an expired owner by changing PG
  time. It now keeps the unrelated lifecycle scenario on a valid identity; the
  separate new regression proves permanent loss cannot revive.
- An initial edit removed a constant still used to bound one sidebar response.
  That response bound is retained with a precise name, separate from Fork/prune.
- The large test initially timed out in the cold-retention reference join. Actual
  isolated PG activity identified the query; fixing that join made the complete
  suite pass without increasing the timeout.
- A reading-window unit fixture omitted the normal settled-message identity
  transition before merging a canonical page. It now exercises that transition.
- A formatting invocation enumerated a removed, unstaged script. Changed-file
  formatting now excludes missing paths; clean-checkout formatting is verified
  separately before publication.

Current source verification: 2,345 workspace tests passed, 11 opt-in cases skipped;
133 acceptance-helper tests passed. All package typechecks are covered, including
rechecks of two newly typed test fixtures. RF3 Kafka transport passed nine cases;
Cube admission/allocation contracts, build, Helm, installation, runtime policy,
observability, image closure/context and dependency audit passed. The maintained
full browser presentation, queue, Skill and schedule checks pass. Two initial
presentation invocations timed out loading a dev fixture; a scoped recheck and
the complete recheck passed. The initial cause remains unestablished; bounded
network-failure diagnostics are retained for a recurrence.

Evidence is private under
`deploy/production/runtime/work-evidence/review-repairs-20261101/`.
Original transcripts, credentials, application repositories and raw runtime
inventories are not committed. The deferred 131 MiB cold-image experiment remains deferred.

## Matched publication and live acceptance

The clean committed revision passed **383/383** deterministic fault cases. This
supersedes the initial 382/383 invocation with its stale test title; the failed
sample and the isolated target recheck are retained separately. All 2,345 workspace
tests and 133 acceptance-helper cases passed, with 11 opt-in cases skipped. The
remaining source, transport, Cube, browser and image gates described above passed.
These overlapping suites are not independent fleet-scale experiments.

Live checks used GPT-6 Luna and newly owned fixture tenants/Workspaces:

- Three Skill Runs verified instruction reading without a VM, package placement
  followed by Bash, pinned version selection and idle steer admission.
- Fork acceptance verified active-source Forks, source pruning while the Fork
  runs, independent source deletion, retained images, native cold continuation,
  compaction and actual browser navigation. The model recalled the retained C
  context while the pruned source continued from B.
- Guest Chromium interaction/screenshot, `show_image` display and the named
  application preview link passed.
- Native input passed consumption, Stop and Worker recovery with stable input
  identity. Streaming Stop and simultaneous Worker/Control Plane SIGKILL retained
  partial text without keeping streaming bodies in PG. The transient `kubectl`
  connection error during the deliberate Control Plane kill is retained beside
  the confirmed exit/restart and successful continuation.

Every fixture confirmed physical cleanup before its exact tenant was removed.
Original tenant names were never used as a cleanup selector.

Before cutover, a real user Run started while images were being prepared. It was
allowed to finish naturally. Subsequent checks found no active Run, writer,
binding, terminal, elastic fixture or pending control publication. Both original
machine allocations were closed and their absence confirmed on the recorded node
before live handles were cleared. Workspace Volumes and desired running state
remained. The machines recovered at generations 38 and 8; their new allocations
survived the later fault tests unchanged.

Fresh process inventory found no listening application on the first machine and
one application on port 8000 on the second. Only that observed application was
restored, and its returned HTML hash matched before/after and after crash acceptance.
No historical gallery processes were inferred from an old release inventory.

Preservation covered **6,006 files, 150 retained images, 14 protected database
relations and 27 configuration/credential files**. Immediately after deployment,
before application startup, every file matched the strict stopped baseline. Final
verification matched all protected rows, credentials and images; only the known
application log and periodically refreshed `pm/data/snapshot.json.gz` differed.
All 29 running Pods were Ready, with no remaining fixture Run/writer/binding,
terminal, elastic allocation or unpublished control record.

One operational sequencing error is retained explicitly: the apply command was
started before the initial post-retirement file-check failure was inspected. Its
owned operator processes were paused during image import, before runtime cutover.
Comparison found no added/deleted files and only the log/refreshing snapshot above,
already classified in the preceding release's final verification. After verifying
that exact difference, a strict stopped baseline was captured and apply resumed.
The check was not suppressed and no ownership/absence guard was removed.

Local disk preparation removed 257 application-image cache tags older than a week,
excluding every current workload/catalog image and every Docker container image.
Serving catalog hashes stayed unchanged. Earlier bounded BuildKit cache-prune
attempts reclaimed no bytes. No Workspace, database volume, current image or
provider credential was removed by that cache cleanup.
