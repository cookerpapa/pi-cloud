import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPage } from "../src/AdminPage.tsx";
import { AuthScreen } from "../src/AuthScreen.tsx";
import ChatApp from "../src/ChatApp.tsx";
import { ConversationTreeNavigator } from "../src/ConversationTreeNavigator.tsx";
import { ConversationTurn } from "../src/ConversationTurn.tsx";
import { conversationPreviewHref, Markdown } from "../src/Markdown.tsx";
import { ToolActivity } from "../src/ToolActivity.tsx";
import { PiCloudApi } from "../src/api.ts";
import { ResourceManagementPage, resourceRefreshPending } from "../src/ResourceManagementPage.tsx";
import type { TurnView } from "../src/session-view.ts";
import { WorkspaceDirectoryPicker } from "../src/WorkspaceDirectoryPicker.tsx";
import { WorkspaceInspector } from "../src/WorkspaceInspector.tsx";

function turn(turnId: string, prompt: string): TurnView {
  return {
    runId: null,
    turnId,
    mailboxPosition: null,
    prompt,
    acceptedAt: null,
    status: "completed",
    items: [],
    startedSequence: null,
    terminalSequence: null,
    stopReason: "stop",
    failure: null,
    cancellation: null,
    providerHostedTool: null,
  };
}

describe("product chat experience", () => {
  it("polls resource projection only while an environment is transitioning", () => {
    const environment = {
      environmentId: "10000000-0000-4000-8000-000000000001",
      projectId: "10000000-0000-4000-8000-000000000002",
      workspaceId: "10000000-0000-4000-8000-000000000003",
      workspaceName: "acceptance",
      generation: 1,
      profileKey: "standard" as const,
      cpuCount: 2,
      memoryMiB: 4_096,
      systemDiskGiB: 16,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    expect(resourceRefreshPending([{ ...environment, state: "provisioning" }])).toBe(true);
    expect(resourceRefreshPending([{ ...environment, state: "running" }])).toBe(false);
  });

  it("maps arbitrary localhost application links through the authenticated conversation gateway", () => {
    const sessionId = "10000000-0000-4000-8000-000000000001";
    expect(conversationPreviewHref("http://localhost:5173/game?mode=demo", sessionId)).toBe(
      `/v1/conversations/${sessionId}/preview/5173/game?mode=demo`,
    );
    expect(conversationPreviewHref("https://example.com/app", sessionId)).toBe(
      "https://example.com/app",
    );
    expect(conversationPreviewHref("http://localhost:49983/health", sessionId)).toBe(
      "http://localhost:49983/health",
    );
  });

  it("renders a bare localhost URL as an authenticated application action", () => {
    const sessionId = "10000000-0000-4000-8000-000000000099";
    const markup = renderToStaticMarkup(
      <Markdown sessionId={sessionId}>http://127.0.0.1:8000/snake.html</Markdown>,
    );
    expect(markup).toContain("打开应用（端口 8000）↗");
    expect(markup).toContain(`/v1/conversations/${sessionId}/preview/8000/snake.html`);
    expect(markup).not.toContain(">http://127.0.0.1:8000/snake.html<");
  });

  it("restores a durable login without rendering the old operator console", () => {
    const markup = renderToStaticMarkup(<ChatApp />);
    expect(markup).toContain("正在恢复登录状态");
    expect(markup).not.toContain(">A<");
    expect(markup).not.toContain("PostgreSQL outbox");
    expect(markup).not.toContain("Configure tenant model credential");
  });

  it("renders familiar username/password login and registration without API-token fields", () => {
    const markup = renderToStaticMarkup(
      <AuthScreen
        api={new PiCloudApi(async () => new Response(null, { status: 500 }))}
        onAuthenticated={() => undefined}
      />,
    );
    expect(markup).toContain("登录");
    expect(markup).toContain("注册");
    expect(markup).toContain("用户名");
    expect(markup).toContain("密码");
    expect(markup).not.toContain("API token");
    expect(markup).not.toContain("配置模型");
  });

  it("renders platform configuration in a dedicated administrator page", () => {
    const markup = renderToStaticMarkup(
      <AdminPage
        api={new PiCloudApi(async () => new Response(null, { status: 500 }))}
        identity={{
          tenantId: "10000000-0000-4000-8000-000000000001",
          tenantSlug: "platform",
          userId: "10000000-0000-4000-8000-000000000002",
          displayName: "Platform Admin",
          role: "owner",
          authenticationKind: "local",
          platformAdministrator: true,
        }}
        onLogout={() => undefined}
      />,
    );
    expect(markup).toContain("PiCloud 管理后台");
    expect(markup).toContain("Pi Worker 模型");
    expect(markup).toContain("CubeSandbox 公网代理");
    expect(markup).not.toContain("最近对话");
  });

  it("renders the Workspace as a directory without executing browser effects", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceInspector
        api={new PiCloudApi(async () => new Response(null, { status: 500 }))}
        onClose={() => undefined}
        onError={() => undefined}
        refreshSignal={0}
        sessionId="10000000-0000-4000-8000-000000000001"
        workspaceId="10000000-0000-4000-8000-000000000002"
        workspaceName="order-service"
      />,
    );
    expect(markup).toContain("WORKSPACE");
    expect(markup).toContain("order-service");
    expect(markup).toContain("/workspace");
    expect(markup).not.toContain("runs");
    expect(markup).not.toContain("usage");
  });

  it("keeps Workspace and exclusive-environment lifecycle controls on a dedicated page", () => {
    const api = new PiCloudApi(async () => new Response(null, { status: 500 }));
    const markup = renderToStaticMarkup(
      <ResourceManagementPage
        api={api}
        conversations={[]}
        environments={[]}
        onClose={() => undefined}
        onRefresh={async () => undefined}
        profiles={[
          {
            key: "standard",
            label: "标准",
            cpuCount: 2,
            memoryMiB: 4096,
            systemDiskGiB: 40,
            recommended: true,
          },
        ]}
        workspaces={[]}
      />,
    );
    expect(markup).toContain(">资源<");
    expect(markup).toContain("暂无 Workspace");
    expect(markup).not.toContain("Workspace 只在“弹性执行”新建对话时创建");
    expect(markup).not.toContain("新建 Workspace");
    expect(markup).toContain("云端开发机");
    expect(markup).toContain("> 对话</button>");
    expect(markup).not.toContain("GitLab 项目接入");
    expect(markup).not.toContain("项目 Access Token");
    expect(markup).not.toContain(">GitLab ");
  });

  it("keeps deployment GitLab credentials out of the Issue task surface", () => {
    const markup = renderToStaticMarkup(
      <ResourceManagementPage
        api={new PiCloudApi(async () => new Response(null, { status: 500 }))}
        conversations={[]}
        environments={[]}
        initialTab="source-control"
        onClose={() => undefined}
        onRefresh={async () => undefined}
        profiles={[]}
        workspaces={[]}
      />,
    );
    expect(markup).toContain("暂无待处理的 Issue 任务");
    expect(markup).not.toContain("GitLab 地址");
    expect(markup).not.toContain("项目路径或 ID");
    expect(markup).not.toContain("项目 Access Token");
    expect(markup).not.toContain("连接项目");
  });

  it("presents an exclusive environment directory as an Explorer-style persisted root", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceDirectoryPicker
        api={new PiCloudApi(async () => new Response(null, { status: 500 }))}
        environmentId="10000000-0000-4000-8000-000000000099"
        initialDirectory="/home"
        onCancel={() => undefined}
        onChoose={() => undefined}
        workspaceName="exclusive-devbox"
      />,
    );
    expect(markup).toContain("选择文件夹");
    expect(markup).toContain("主文件夹");
    expect(markup).toContain("计算机");
    expect(markup).toContain("新建文件夹");
    expect(markup).toContain("当前选择");
    expect(markup).toContain("/home");
    expect(markup).not.toContain("Workspace");
  });

  it("renders Pi conversation forks in focused and whole-tree navigation", () => {
    const rootSessionId = "10000000-0000-4000-8000-000000000021";
    const childSessionId = "10000000-0000-4000-8000-000000000022";
    const rootTurnId = "10000000-0000-4000-8000-000000000023";
    const rootEntryId = "10000000-0000-4000-8000-000000000024";
    const markup = renderToStaticMarkup(
      <ConversationTreeNavigator
        loading={false}
        onNavigate={() => undefined}
        onViewChange={() => undefined}
        scrollerRef={{ current: null }}
        tree={{
          rootSessionId,
          currentSessionId: childSessionId,
          view: "full",
          delegatedSessions: [
            {
              executionId: "10000000-0000-4000-8000-000000000031",
              sessionId: "10000000-0000-4000-8000-000000000032",
              parentSessionId: rootSessionId,
              rootSessionId,
              depth: 1,
              parentTurnId: rootTurnId,
              title: "worker · subagent",
              agentName: "worker",
              contextMode: "fork",
              workspaceMode: "shared",
              state: "completed",
              workspaceName: "sorting",
              createdAt: "2026-08-15T00:00:00.500Z",
              settledAt: "2026-08-15T00:00:01.500Z",
            },
            {
              executionId: "10000000-0000-4000-8000-000000000033",
              sessionId: "10000000-0000-4000-8000-000000000034",
              parentSessionId: rootSessionId,
              rootSessionId,
              depth: 1,
              parentTurnId: rootTurnId,
              title: "scout · subagent",
              agentName: "scout",
              contextMode: "fresh",
              workspaceMode: "none",
              state: "completed",
              workspaceName: "sorting",
              createdAt: "2026-08-15T00:00:00.600Z",
              settledAt: "2026-08-15T00:00:01.600Z",
            },
          ],
          branches: [
            {
              kind: "conversation",
              sessionId: rootSessionId,
              title: "排序算法",
              parentSessionId: null,
              forkedFromTurnId: null,
              forkedFromEntryId: null,
              current: false,
              entries: [
                {
                  entryId: "10000000-0000-4000-8000-000000000025",
                  parentEntryId: null,
                  turnId: rootTurnId,
                  role: "user",
                  text: "写一个插入排序并测试",
                  finalAssistant: false,
                  createdAt: "2026-08-15T00:00:00.000Z",
                },
                {
                  entryId: rootEntryId,
                  parentEntryId: "10000000-0000-4000-8000-000000000025",
                  turnId: rootTurnId,
                  role: "assistant",
                  text: "插入排序已经通过测试。",
                  finalAssistant: true,
                  createdAt: "2026-08-15T00:00:01.000Z",
                },
              ],
            },
            {
              kind: "conversation",
              sessionId: childSessionId,
              title: "改用泛型实现",
              parentSessionId: rootSessionId,
              forkedFromTurnId: rootTurnId,
              forkedFromEntryId: rootEntryId,
              current: true,
              entries: [],
            },
            {
              kind: "subagent",
              sessionId: "10000000-0000-4000-8000-000000000032",
              title: "worker · subagent",
              parentSessionId: rootSessionId,
              forkedFromTurnId: rootTurnId,
              forkedFromEntryId: rootEntryId,
              current: false,
              agentName: "worker",
              contextMode: "fork",
              workspaceMode: "shared",
              delegatedState: "completed",
              entries: [],
            },
            {
              kind: "subagent",
              sessionId: "10000000-0000-4000-8000-000000000034",
              title: "scout · subagent",
              parentSessionId: rootSessionId,
              forkedFromTurnId: rootTurnId,
              forkedFromEntryId: rootEntryId,
              current: false,
              agentName: "scout",
              contextMode: "fresh",
              workspaceMode: "none",
              delegatedState: "completed",
              entries: [],
            },
          ],
        }}
        view="full"
      />,
    );
    expect(markup).toContain("对话导航");
    expect(markup).toContain("当前分支");
    expect(markup).toContain("整棵树");
    expect(markup).toContain("写一个插入排序并测试");
    expect(markup).toContain("改用泛型实现");
    expect(markup).toContain("product-tree-user");
    expect(markup).toContain("product-tree-assistant");
    expect(markup).toContain("worker");
    expect(markup).toContain("继承上下文");
    expect(markup).toContain("共享工作区");
    expect(markup).toContain("scout");
    expect(markup).toContain("独立上下文");
    expect(markup).toContain("无工具");
  });

  it("renders an active Snapshot prefix immediately instead of replaying it from empty", () => {
    const recovered = "这是刷新前已经由 Kafka 持久化的完整文本前缀。";
    const markup = renderToStaticMarkup(
      <ConversationTurn
        turn={{
          ...turn("10000000-0000-4000-8000-000000000014", "继续当前任务"),
          status: "running",
          stopReason: null,
          items: [
            {
              kind: "text",
              key: "text:7",
              text: recovered,
              firstSequence: 7,
              lastSequence: 12,
              recoveredTextLength: recovered.length,
            },
          ],
        }}
      />,
    );
    expect(markup).toContain(recovered);
  });

  it("offers a fork action only after a completed final response", () => {
    const markup = renderToStaticMarkup(
      <ConversationTurn
        canFork
        canPrune
        onFork={() => undefined}
        onPrune={() => undefined}
        turn={turn("10000000-0000-4000-8000-000000000026", "保留这一条路径")}
      />,
    );
    expect(markup).toContain("从此对话开始");
    expect(markup).toContain("删除后续");
  });

  it("offers copy actions for the user message and completed final response", () => {
    const markup = renderToStaticMarkup(
      <ConversationTurn
        turn={{
          ...turn("10000000-0000-4000-8000-000000000027", "请解释这个实现"),
          items: [
            {
              kind: "text",
              key: "text:1",
              text: "这是最终回答。",
              firstSequence: 1,
              lastSequence: 2,
            },
          ],
        }}
      />,
    );
    expect(markup).toContain('aria-label="复制用户消息"');
    expect(markup).toContain('aria-label="复制回答"');
  });

  it("renders Pi-style command output instead of a collapsed JSON tool card", () => {
    const markup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:bash-1",
          toolCallId: "bash-1",
          toolName: "bash",
          input: { command: "python3 bubble_sort.py" },
          output: {
            content: [
              {
                type: "text",
                text: "/bin/bash: python3: command not found\n\nCommand exited with code 127",
              },
            ],
            details: {},
          },
          status: "failed",
          firstSequence: 4,
          lastSequence: 5,
          startedAt: "2026-07-21T00:00:00.000Z",
          completedAt: "2026-07-21T00:00:01.240Z",
        }}
      />,
    );
    expect(markup).toContain("$</span><code>python3 bubble_sort.py</code>");
    expect(markup).toContain("python3: command not found");
    expect(markup).toContain("Command exited with code 127");
    expect(markup).toContain("耗时 1.2s");
    expect(markup).not.toContain("&quot;content&quot;");
    expect(markup).not.toContain("输入</span>");
  });

  it("renders a multiline Bash call as a Pi-style terminal command block", () => {
    const markup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:bash-multiline",
          toolCallId: "bash-multiline",
          toolName: "bash",
          input: { command: "cd /tmp\necho download\ncurl -sL https://example.test/archive" },
          output: { content: [{ type: "text", text: "done" }] },
          status: "completed",
          firstSequence: 8,
          lastSequence: 9,
          startedAt: "2026-08-21T00:00:00.000Z",
          completedAt: "2026-08-21T00:00:00.100Z",
        }}
      />,
    );
    expect(markup).toContain("3 行命令");
    expect(markup).toContain("product-tool-command-block");
    expect(markup).toContain("$ cd /tmp");
    expect(markup).toContain("  echo download");
    expect(markup).toContain("curl -sL");
  });

  it("renders a Preview Tool result as the application link instead of a top-bar hint", () => {
    const markup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:preview-1",
          toolCallId: "preview-1",
          toolName: "preview",
          input: { port: 3_000 },
          output: {
            content: [{ type: "text", text: "PiCloud published the verified service." }],
            details: {
              port: 3_000,
              previewPath: "/v1/conversations/10000000-0000-4000-8000-000000000099/preview/3000/",
            },
          },
          status: "completed",
          firstSequence: 10,
          lastSequence: 11,
          startedAt: "2026-08-25T00:00:00.000Z",
          completedAt: "2026-08-25T00:00:00.100Z",
        }}
      />,
    );
    expect(markup).toContain("打开应用（端口 3000）");
    expect(markup).toContain(
      "/v1/conversations/10000000-0000-4000-8000-000000000099/preview/3000/",
    );
    expect(markup).not.toContain("127.0.0.1");
  });

  it("renders write paths and a bounded source preview like Pi", () => {
    const content = Array.from({ length: 20 }, (_, index) => `line ${String(index + 1)}`).join(
      "\n",
    );
    const markup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:write-1",
          toolCallId: "write-1",
          toolName: "write",
          input: { path: "/workspace/bubble_sort.py", content },
          output: {
            content: [
              {
                type: "text",
                text: "Successfully wrote 151 bytes to /workspace/bubble_sort.py",
              },
            ],
          },
          status: "completed",
          firstSequence: 6,
          lastSequence: 7,
          startedAt: "2026-07-21T00:00:00.000Z",
          completedAt: "2026-07-21T00:00:00.010Z",
        }}
      />,
    );
    expect(markup).toContain("<strong>write</strong><code>/workspace/bubble_sort.py</code>");
    expect(markup).toContain("line 1");
    expect(markup).toContain("后面还有 4 行");
    expect(markup).not.toContain("Successfully wrote");
    expect(markup).toContain("耗时 0.0s");
  });

  it("renders read output as source and edit input as a compact diff", () => {
    const readMarkup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:read-1",
          toolCallId: "read-1",
          toolName: "read",
          input: { path: "/workspace/main.ts", offset: 10, limit: 20 },
          output: "export const answer = 42;",
          status: "completed",
          firstSequence: 1,
          lastSequence: 2,
          startedAt: "2026-08-24T00:00:00.000Z",
          completedAt: "2026-08-24T00:00:00.100Z",
        }}
      />,
    );
    expect(readMarkup).toContain("<strong>read</strong>");
    expect(readMarkup).toContain("/workspace/main.ts");
    expect(readMarkup).toContain("L10 +20");
    expect(readMarkup).toContain("export const answer = 42;");

    const editMarkup = renderToStaticMarkup(
      <ToolActivity
        item={{
          kind: "tool",
          key: "tool:edit-1",
          toolCallId: "edit-1",
          toolName: "edit",
          input: {
            path: "/workspace/main.ts",
            edits: [{ oldText: "return 41;", newText: "return 42;" }],
          },
          output: "Successfully edited /workspace/main.ts",
          status: "completed",
          firstSequence: 3,
          lastSequence: 4,
          startedAt: "2026-08-24T00:00:00.000Z",
          completedAt: "2026-08-24T00:00:00.100Z",
        }}
      />,
    );
    expect(editMarkup).toContain("product-diff-removed");
    expect(editMarkup).toContain("return 41;");
    expect(editMarkup).toContain("product-diff-added");
    expect(editMarkup).toContain("return 42;");
    expect(editMarkup).not.toContain("Successfully edited");
  });

  it("folds adjacent completed Tools into one stable activity row", () => {
    const groupedTurn: TurnView = {
      ...turn("10000000-0000-4000-8000-000000000040", "检查并修改"),
      items: [
        {
          kind: "tool",
          key: "tool:read-group",
          toolCallId: "read-group",
          toolName: "read",
          input: { path: "/workspace/main.ts" },
          output: "old",
          status: "completed",
          firstSequence: 1,
          lastSequence: 2,
          startedAt: "2026-08-24T00:00:00.000Z",
          completedAt: "2026-08-24T00:00:00.100Z",
        },
        {
          kind: "tool",
          key: "tool:write-group",
          toolCallId: "write-group",
          toolName: "write",
          input: { path: "/workspace/main.ts", content: "new" },
          output: "Successfully wrote 3 bytes to /workspace/main.ts",
          status: "completed",
          firstSequence: 3,
          lastSequence: 4,
          startedAt: "2026-08-24T00:00:00.100Z",
          completedAt: "2026-08-24T00:00:00.200Z",
        },
      ],
    };
    const markup = renderToStaticMarkup(<ConversationTurn turn={groupedTurn} />);
    expect(markup).toContain("2 个步骤");
    expect(markup).toContain("read · write");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Successfully wrote");
  });

  it("renders durable Pi compaction and model retry lifecycle rows", () => {
    const lifecycleTurn: TurnView = {
      ...turn("10000000-0000-4000-8000-000000000041", "继续长上下文任务"),
      items: [
        {
          kind: "compaction",
          key: "compaction:1",
          reason: "threshold",
          status: "completed",
          willRetry: true,
          tokensBefore: 100_000,
          estimatedTokensAfter: 24_000,
          firstSequence: 1,
          lastSequence: 2,
        },
        {
          kind: "retry",
          key: "retry:3",
          nextSamplingAttempt: 2,
          maximumSamplingAttempts: 3,
          delayMs: 1_500,
          sequence: 3,
        },
      ],
    };
    const markup = renderToStaticMarkup(<ConversationTurn turn={lifecycleTurn} />);
    expect(markup).toContain("上下文已压缩");
    expect(markup).toContain("100,000 → 24,000 tokens");
    expect(markup).toContain("正在继续当前任务");
    expect(markup).toContain("1.5s 后重试");
  });
});
