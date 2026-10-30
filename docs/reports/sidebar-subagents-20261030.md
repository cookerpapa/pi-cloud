# Collapsible sidebar subagent conversations

Conversation rows with delegated children have an independent disclosure button.
All subagent subtrees start collapsed. Expansion is local to the page and retained
while navigating or refreshing the list; a page reload starts collapsed again.
The button does not select another conversation, cancel work, or change the open
child's read-only view. Manual Forks remain peers and are never folded into their
source conversation. Rows without children have no disclosure control.

The existing browser cases now verify the collapsed default, toggle state,
selection preservation, child navigation, peer layout and independent deletion.
Source verification and a scoped Web release are in progress. No API, schema,
Worker, sandbox or model-context changes are required.

Private evidence:
`deploy/production/runtime/work-evidence/sidebar-subagents-20261030/`.
