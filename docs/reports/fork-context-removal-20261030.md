# Remove automatic Fork identity instructions

The owner approved removing the default Fork notice after comparing Codex's
behavior. ADR-0287 records the amendment. Source implementation is complete;
matched deployment and live verification are pending.

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
