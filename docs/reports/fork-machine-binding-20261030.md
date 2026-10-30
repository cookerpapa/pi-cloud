# Fork Workspace and development-machine inheritance

The Fork path copied execution mode, Workspace and directory but omitted the
stable development-machine ID from insertion and both response paths. The Web
header then labelled an unresolved machine as elastic. The correction preserves
that ID in storage, creation and idempotent replay, without adding VM creation
or lifecycle calls. The current live inventory had no missing machine bindings,
so no historical-data migration or speculative repair is introduced.

The source binding is captured from one Session-row read. Later source changes
do not move an existing Fork. Paused/released machines keep their identity and
normal Run admission rules. A missing identity on a machine-bound source is
reported as invalid configuration. Temporary child compute identities and leases
are not inherited. ADR-0287 records this clarification.

The Web header uses the actual execution mode and directory. A missing identity
or unresolved machine has an explicit label; known non-running resource states
are shown. There is no fallback to an elastic label or automatic new machine.

Source verification and matched publication are in progress. The dedicated
machine tests cover running, paused and released state, nested Forks, persisted
bindings, replay, no lifecycle mutations and subsequent Run admission. Browser
checks cover normal, paused, released, unavailable and missing-binding display.
Private evidence is under
`deploy/production/runtime/work-evidence/fork-machine-binding-20261030/`.
