import type { ConversationDetailResource } from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import {
  conversationExportFilename,
  conversationExportMarkdown,
} from "../src/conversation-export.ts";

const conversation = {
  project: {
    projectId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    name: "export-project",
    workspaceState: "available",
  },
  session: {
    sessionId: "10000000-0000-4000-8000-000000000003",
    projectId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    title: "导出 / 会话",
    state: "idle",
    executionMode: "elastic",
    workingDirectory: "/workspace",
    workspaceState: "available",
    sessionKind: "conversation",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:01:00.000Z",
  },
  inheritedMessages: [],
  turns: [
    {
      runId: "10000000-0000-4000-8000-000000000004",
      turnId: "10000000-0000-4000-8000-000000000005",
      commandId: "10000000-0000-4000-8000-000000000006",
      mailboxPosition: 1,
      prompt: "写一个服务",
      state: "completed",
      acceptedAt: "2026-08-26T00:00:01.000Z",
      transcript: {
        schemaVersion: 1,
        throughSequence: 4,
        startedSequence: 1,
        terminalSequence: 4,
        stopReason: "stop",
        failure: null,
        cancellation: null,
        workspacePatch: null,
        items: [
          { kind: "text", text: "完成。", firstSequence: 1, lastSequence: 1 },
          {
            kind: "tool",
            toolCallId: "preview-1",
            toolName: "preview",
            input: { port: 4_173 },
            output: {
              content: [{ type: "text", text: "Published" }],
              details: { previewPath: "/v1/conversations/id/preview/4173/" },
            },
            status: "completed",
            firstSequence: 2,
            lastSequence: 3,
            startedAt: "2026-08-26T00:00:02.000Z",
            completedAt: "2026-08-26T00:00:03.000Z",
          },
        ],
      },
    },
    {
      runId: "10000000-0000-4000-8000-000000000007",
      turnId: "10000000-0000-4000-8000-000000000008",
      commandId: "10000000-0000-4000-8000-000000000009",
      mailboxPosition: 2,
      prompt: "尚未完成的消息",
      state: "running",
      acceptedAt: "2026-08-26T00:02:00.000Z",
    },
  ],
  historyTruncated: false,
} as unknown as ConversationDetailResource;

describe("canonical conversation Markdown export", () => {
  it("exports terminal canonical messages and Tool details without live deltas", () => {
    const markdown = conversationExportMarkdown(conversation, new Date("2026-08-26T01:02:03.000Z"));
    expect(markdown).toContain('schema: "pi-cloud.session-export.v1"');
    expect(markdown).toContain("### User\n\n写一个服务");
    expect(markdown).toContain("完成。");
    expect(markdown).toContain("Tool · preview · completed");
    expect(markdown).toContain("previewPath");
    expect(markdown).not.toContain("尚未完成的消息");
    expect(markdown).not.toContain("assistant.text.delta");
  });

  it("creates a portable bounded Markdown filename", () => {
    expect(conversationExportFilename("导出 / 会话", new Date("2026-08-26T01:02:03.000Z"))).toBe(
      "导出 - 会话-2026-08-26T01-02-03-000Z.md",
    );
  });
});
