# PiCloud Web UI

This package is the browser product for PiCloud. It talks only to the public
REST, snapshot-first SSE and brokered Terminal endpoints; it never opens Pi,
PostgreSQL, Cube or provider credentials directly.

## Current behavior

- username/password registration and HttpOnly-cookie login;
- tenant-scoped named Workspaces and conversations;
- resizable conversation list and focused/full Pi Session tree;
- read-only Subagent Lane views with context/Workspace-mode labels;
- ordered assistant, Tool and lifecycle rendering from durable SSE;
- active Turn cancellation and steer;
- conversation forks, recursive subtree deletion and settled-answer tail
  pruning;
- live Workspace directory/source view, authenticated service preview and
  a brokered xterm terminal;
- a separate administrator settings product for model and Cube proxy policy.

Tail pruning changes conversation context only. It retains the selected final
Assistant entry, hides later Turns/branches/Subagents and lets the next Pi Run
continue from that entry. Workspace files are unchanged.

SSE opens with complete history plus the already-durable pending text, then
follows new output without a browser cursor. The frontend animates only new
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

The supported persistent product is started with `npm run production:up` (or
installed with `./install.sh`). Frontend-only development may point Vite at a
compatible loopback API using the package's existing `dev` command.
