import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PiCloudApi } from "../src/api.ts";
import { AuthScreen } from "../src/AuthScreen.tsx";
import { ConversationTurn } from "../src/ConversationTurn.tsx";
import { I18nProvider, translate } from "../src/i18n.tsx";
import type { TurnView } from "../src/session-view.ts";

describe("UI internationalization", () => {
  it("keeps both dictionaries complete and interpolates dynamic UI values", () => {
    expect(translate("zh-CN", "resource.workspaceConversations", { count: 3 })).toBe("3 个对话");
    expect(translate("en-US", "resource.workspaceConversations", { count: 3 })).toBe("3 chats");
    expect(translate("en-US", "chat.exclusive", { name: "backend-dev" })).toBe(
      "Cloud development machine backend-dev",
    );
  });

  it("renders English product chrome without translating model or conversation data", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLanguage="en-US">
        <AuthScreen
          api={new PiCloudApi(async () => new Response(null, { status: 500 }))}
          onAuthenticated={() => undefined}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("Log in");
    expect(markup).toContain("Register");
    expect(markup).toContain("Username");
    expect(markup).toContain("Interface language");
    expect(markup).not.toContain("欢迎回来");

    const turn: TurnView = {
      runId: null,
      turnId: "turn-i18n",
      commandId: null,
      mailboxPosition: null,
      prompt: "用户原始消息",
      acceptedAt: null,
      status: "completed",
      items: [
        {
          kind: "text",
          key: "answer-i18n",
          text: "模型原始回答",
          firstSequence: 1,
          lastSequence: 1,
        },
      ],
      startedSequence: null,
      terminalSequence: null,
      stopReason: "stop",
      failure: null,
      cancellation: null,
      workspacePatch: null,
    };
    const conversation = renderToStaticMarkup(
      <I18nProvider initialLanguage="en-US">
        <ConversationTurn turn={turn} />
      </I18nProvider>,
    );
    expect(conversation).toContain("用户原始消息");
    expect(conversation).toContain("模型原始回答");
  });
});
