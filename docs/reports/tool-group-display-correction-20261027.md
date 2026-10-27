# Tool group display correction

Status: source/browser checks pass; Web-only publication pending.

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

Private evidence: `deploy/production/runtime/release-evidence/tool-group-fix-20261027/`.
