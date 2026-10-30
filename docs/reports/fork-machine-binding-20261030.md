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

Matched `fork-machine-binding-20261030` is deployed from `51fe703c`, schema 205
unchanged, application Helm revision 129. The dedicated
machine tests cover running, paused and released state, nested Forks, persisted
bindings, replay, no lifecycle mutations and subsequent Run admission. Browser
checks cover normal, paused, released, unavailable and missing-binding display.
Private evidence is under
`deploy/production/runtime/work-evidence/fork-machine-binding-20261030/`.

Forty backend checks, 220 Web tests, the full browser presentation gate, affected
Control Plane/Web/Worker typechecks, formatting, documentation and image closure
pass. All 12 matched images pass their release gates.

Real GPT-6 Luna acceptance used an owned development machine and a custom
`/home/user/fork-binding` directory. The source wrote a marker file; the Fork and
its idempotent replay returned the same machine, Workspace and directory. The
Fork's Bash read that file from the same directory, and the allocation ID and
generation remained unchanged. Only one machine was created for the fixture.
The deployed Web header showed the bound machine. Fixture conversations, machine,
Volume and tenant were removed after confirmed physical cleanup.

The original machine recovered as generation 31 on its retained Workspace.
Fourteen protected database tables/views, 68 images, 5,859 Workspace files and
27 private configuration hashes match the pre-release capture. All 29 runtime
Pods are Ready. Release evidence is under
`deploy/production/runtime/release-evidence/fork-machine-binding-20261030/`;
the owned-machine report and screenshot are in the work-evidence directory above.
