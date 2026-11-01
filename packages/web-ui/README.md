# PiCloud Web UI

This package is the browser product for PiCloud. It talks only to the public
REST, snapshot-first SSE and Terminal endpoints; it never opens Pi,
PostgreSQL, Cube or provider credentials directly.

## Current behavior

- username/password registration and HttpOnly-cookie login;
- tenant-scoped named Workspaces and conversations;
- resizable conversation list and focused/full Pi Session tree;
- read-only Subagent Lane views with context and shared/ephemeral compute labels;
- ordered assistant, Tool and lifecycle rendering from durable SSE;
- active Turn cancellation, editable steer/follow-up queues and input commands;
- independent peer Forks, collapsible native children and settled-answer pruning;
- live Workspace directory/source view, authenticated service preview and
  a brokered xterm terminal;
- a separate administrator settings product for model and Cube proxy policy.

Tail pruning changes conversation context only. It retains the selected final
Assistant entry, hides later Turns/branches/Subagents and lets the next Pi Run
continue from that entry. Workspace files are unchanged.

SSE opens with a bounded canonical/live snapshot, then follows new output.
Older history uses native-position pagination and bounded virtual rendering.
Reading and selection freeze text, while completion/failure/cancellation stay
current. Frozen partial text does not become a complete-answer copy. The frontend animates only new
text. Markdown uses the existing remark/GFM parser with stable complete blocks;
settlement does not replace already-rendered paragraphs. Model selection stays
in the composer and persists through the API, not in browser-only state.

All public resources and events are validated with `@pi-cloud/protocol` before
entering React state. Markdown raw HTML is disabled, remote images are inert,
unknown Tool values are bounded, and file preview accepts at most 512 KiB of
valid UTF-8. The browser never logs request bodies, events, tokens or credential
references.

## Verify

From the repository root:

```bash
npm run build --workspace @pi-cloud/web-ui
npm run typecheck --workspace @pi-cloud/web-ui
npm run test --workspace @pi-cloud/web-ui
```

First installation uses `./install.sh`; existing deployments use the maintained
[matched](../../docs/MATCHED_RELEASE.md) or [scoped](../../docs/COMPONENT_RELEASE.md)
release operator. Frontend-only development may point Vite at a
compatible loopback API using the package's existing `dev` command.
