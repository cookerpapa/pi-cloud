import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseComposerCommand, composerCommandSuggestions } from "../src/composer-commands.ts";
import { ConversationTurn } from "../src/ConversationTurn.tsx";
import {
  createInitialSessionView,
  sessionViewReducer,
  type TurnView,
} from "../src/session-view.ts";
import { ConversationUsage } from "../src/ConversationUsage.tsx";

it("intercepts only complete command tokens and preserves instructions", () => {
  expect(parseComposerCommand("/usage")).toEqual({ kind: "usage" });
  expect(parseComposerCommand(" /compact 保留 API\n和待办 ")).toEqual({
    kind: "compact",
    instructions: "保留 API\n和待办",
  });
  expect(parseComposerCommand("/usage extra")).toEqual({
    kind: "invalid",
    reason: "usage_arguments",
  });
  for (const text of [
    "/home/user/project",
    "/compact/file",
    "请解释 /compact",
    "```\n/compact\n```",
    "/compactly",
  ])
    expect(parseComposerCommand(text)).toBeUndefined();
  expect(composerCommandSuggestions("/")).toEqual(["usage", "compact"]);
  expect(composerCommandSuggestions("/com")).toEqual(["compact"]);
  expect(composerCommandSuggestions("/compact keep this")).toEqual([]);
});
it("renders a compact operation without a user or assistant message bubble", () => {
  const turn: TurnView = {
    runId: "run",
    turnId: "turn",
    mailboxPosition: 1,
    prompt: "",
    acceptedAt: null,
    status: "completed",
    items: [],
    startedSequence: 1,
    terminalSequence: 3,
    stopReason: "compact_no_op",
    failure: null,
    cancellation: null,
    operation: { kind: "compact", state: "no_op" },
  };
  const markup = renderToStaticMarkup(<ConversationTurn turn={turn} />);
  expect(markup).toContain("/compact");
  expect(markup).not.toContain("product-user-message");
  expect(markup).not.toContain("product-assistant-message");
});
it("does not create another displayed Run for an active compact receipt", () => {
  const state = createInitialSessionView();
  expect(
    sessionViewReducer(state, {
      type: "compact.accepted",
      compact: {
        commandId: "command",
        sessionId: "session",
        runId: "run",
        turnId: "turn",
        initialOperation: false,
        state: "summarizing",
        acceptedAt: new Date().toISOString(),
        nativeSequence: 1,
        replayed: false,
      },
    }),
  ).toBe(state);
});
it("separates cached input from total input and leaves the context window per conversation", () => {
  const tokens = { input: 100, output: 20, cacheRead: 70, cacheWrite: 0, total: 120 };
  const markup = renderToStaticMarkup(
    <ConversationUsage
      loading={false}
      error={false}
      onRefresh={() => {}}
      onClose={() => {}}
      value={{
        sessionId: "session",
        source: "postgres",
        nativeSequence: 3,
        observedAt: new Date().toISOString(),
        inFlight: false,
        model: { provider: "openai-codex", modelId: "gpt-6-luna" },
        tokens,
        models: [],
        children: [],
        includingChildren: tokens,
        context: {
          estimatedTokens: 200,
          window: 1000,
          compactThreshold: 900,
          method: "structural",
        },
      }}
    />,
  );
  expect(markup).toContain("100");
  expect(markup).toContain("70");
  expect(markup).toContain("120");
  expect(markup).toContain("1,000");
});
