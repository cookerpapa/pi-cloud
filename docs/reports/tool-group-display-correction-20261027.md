# Tool group display correction

Status: deployed Web-only as `tool-groups-40bbf76f`, Helm 117, 2026-10-27.

The owner clarified that the toolbar should change whether consecutive Tools
default to one collapsed group or individual visible cards. The preceding
implementation incorrectly propagated that choice to every Tool's details and
text expansion. Remove that behavior and restore the original Tool renderers.

Only the outer activity group receives the toolbar's default. Global changes
clear group overrides while preserving individual details/text choices. An
explicitly closed group stays closed when another Tool arrives. Existing special
Tool details remain as before; Bash/read/write/edit gain no new details wrapper.
Retry notices continue to update in one row, and image presentation is unchanged.

A browser fixture reproduces horizontal overflow from a long Tool result: a
710 px chat pane acquired 53,171 px of scrollable content. Constrain the Tool-body
grid track and its details child so long lines scroll inside the code block.
Desktop and 390 px mobile checks pass after this correction.

The focused browser check compares a Bash card's exact markup before/after the
global group change, verifies normal text previews and closed special details,
retains manual detail/text choices through group toggles, and checks a later Tool
result does not reopen a manually closed group. No API, native history, model
request or execution policy changes.

The scoped Web gate and all 22 geometry scenarios pass. Read-only live inspection
of galgame opens its four mounted groups, finds zero added details wrappers on
native Tools, and retains the two pre-existing special Tool details as closed.
The chat pane and its scrollable content both measure 710 px. The same button
collapses the groups again. All 28 backend Pod/container identities, the existing
machine allocation and 27 configuration hashes are unchanged; the temporary
viewer credential is removed. Refresh an open page to load the corrected assets.

Private evidence: `deploy/production/runtime/release-evidence/tool-group-fix-20261027/`.
