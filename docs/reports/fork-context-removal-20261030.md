# Remove automatic Fork identity instructions

The owner approved removing the default Fork notice after comparing Codex's
behavior. ADR-0287 records the amendment. Matched `fork-context-removal-20261030`
is deployed from `c75b3275` on schema 204 / application Helm revision 126.
Source checks and real Luna Fork acceptance pass.

The Runner no longer registers `fork-context`; its renderer has been deleted.
Backend provenance remains stored, and `subagent_control` still lists only the
current family and rejects old-family targets. Environment and capability
updates keep their existing behavior.

No transcript rewrite or request filter is introduced. Pi's native section
reconciliation removes the old section from effective instructions on the next
generation. Previously committed system entries retain native history semantics;
this is not a promise to erase historical text. Compaction and cold reopen do
not recreate the removed section. The focused native fixture covers both fresh
provenance and a persisted old section, and verifies unchanged provenance.

The earlier isolated Codex CLI/App Server 0.164.0 experiment found identical
system/developer instructions before Fork, after Fork and after reopen, while
`forkedFromId` remained application metadata. It used a simulated provider and
does not establish every desktop version's behavior. Private evidence is under
`deploy/production/runtime/work-evidence/codex-fork-subagents-20261030/`.

The Worker source change uses the maintained matched publication path on schema
204, without a data migration. Verify native prompt/reopen/compaction and family
target contracts, then real Luna Fork/image/compaction behavior on the deployed
artifacts. Preserve existing conversations, images, configuration and Workspace
files while retiring and restoring compute through its recorded allocation.

## Verification and delivery

Twenty native tests cover prompt retirement, effective instructions, repeated
requests, compaction, reopen and existing runtime behavior. Two PostgreSQL family
checks verify scoped listings and rejection of old Agent targets. Both affected
Worker package typechecks, formatting, documentation and image closure checks
pass. All 12 matched release artifacts pass their image gates.

The maintained live Fork driver now explicitly verifies absence of a generated
`fork-context` section and reads the retained provenance through the public native
Storage API. Real Luna passes those checks, active-source Fork, pruning while the
Fork runs, retained-image access, cold context recall, native compaction and browser
navigation. Its owned resources are physically cleaned and its tenant is removed.

The original development machine recovers as generation 29 with the same
Workspace. All 29 runtime Pods are Ready. Fourteen protected database tables/views,
68 image contents, 5,859 Workspace files and 27 private configuration/credential
hashes match the captured values. There is no business-data reset or schema
migration. Evidence is private under
`deploy/production/runtime/release-evidence/fork-context-removal-20261030/` and
`deploy/production/runtime/work-evidence/fork-context-removal-20261030/`.
