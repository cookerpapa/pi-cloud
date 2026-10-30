# Collapsible sidebar subagent conversations

Conversation rows with delegated children have an independent disclosure button.
All subagent subtrees start collapsed. Expansion is local to the page and retained
while navigating or refreshing the list; a page reload starts collapsed again.
The button does not select another conversation, cancel work, or change the open
child's read-only view. Manual Forks remain peers and are never folded into their
source conversation. Rows without children have no disclosure control.

The existing browser cases now verify the collapsed default, toggle state,
selection preservation, child navigation, peer layout and independent deletion.
Web-only `sidebar-subagents-20261030` is deployed from `cab7dbe9`, Helm revision
128, with schema 205 unchanged. No API, Worker, sandbox or model-context changes
were made.

Web types, 236 scoped tests, full browser presentation/queue/history-layout gates
and the single-image scan pass. A browser loading the served production bundle
with controlled read-only API responses verifies the collapsed default, nested
children, unchanged selection and request count on toggle, reload reset and native
keyboard activation. This check uses synthetic list data, makes no model requests
and performs no backend mutations. Early keyboard-driver attempts lacked the
native Enter character event; the corrected CDP input passes without product code
changes.

All 28 backend Pod identities/restart counts, the existing machine allocation and
27 private configuration hashes match the pre-release snapshot. Existing tabs
need a reload to receive the new Web bundle.

Private evidence:
`deploy/production/runtime/work-evidence/sidebar-subagents-20261030/`.
