# Pi Web transcript rendering survey

Date: 2026-08-24

## Decision

PiCloud keeps its React renderer and PiCloud-owned durable event contract. It
does not depend on the historical `@earendil-works/pi-web-ui` package.

The rendering references, in order, are:

1. Pi's maintained TUI components for Assistant, Bash, Tool and Diff behavior;
2. JetBrains ThinkRail's React presentation rows, activity groups and Tool
   renderer registry;
3. PI WEB and pi-kot for broader browser product interaction.

## Evidence

- Pi SDK explicitly supports custom Web/desktop/mobile interfaces:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md>
- Pi's maintained rendering semantics live under:
  <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/modes/interactive/components>
- the former official Web UI was removed from the Pi main workspace in commit
  `b141e1f`:
  <https://github.com/earendil-works/pi/commit/b141e1fa2>
- ThinkRail renders Pi canonical messages through hand-written React
  presentation rows and a Tool registry:
  <https://github.com/JetBrains/thinkrail/blob/main/apps/web/src/chat/SPEC.md>
- PI WEB is a maintained MIT browser application, but explicitly targets
  trusted local/remote machines rather than a hostile multi-tenant runtime:
  <https://github.com/jmfederico/pi-web>
- pi-kot is another React SDK bridge with REST, SSE and WebSocket:
  <https://github.com/keemzin/pi-kot>

## Adopt versus build

No candidate is a safe drop-in component:

- the retired official package runs the Agent in the browser and uses Lit;
- community applications own local Pi process/session state;
- PiCloud must render canonical PostgreSQL conversation state plus a fenced,
  resumable Accepted-Kafka suffix and cloud-only failure states.

PiCloud therefore adopts the stable interaction patterns rather than a runtime
dependency. The implementation keeps transport/reducer/presentation separate,
derives stable rows, groups adjacent Tools, and selects dedicated renderers for
`bash`, `read`, `write` and `edit`. Pi Compaction and retry lifecycle rows are
rebuilt from native Compaction entries and presentation-only Pi custom entries,
so settled rendering does not depend on retained token deltas and retry notices
do not enter model context.
