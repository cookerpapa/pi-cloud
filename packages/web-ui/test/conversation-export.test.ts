import type { ConversationDetailResource } from "@pi-cloud/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import {
  conversationExportFilename,
  conversationExportMarkdown,
} from "../src/conversation-export.ts";

const conversation: ConversationDetailResource = {
  project: {
    projectId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    name: "export-project",
    createdAt: "2026-08-26T00:00:00.000Z",
    source: { kind: "empty", status: "ready" },
    environment: {
      environmentVersionId: "10000000-0000-4000-8000-000000000010",
      versionNumber: 1,
      profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
      profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
      specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
      imageRevision: "fixture",
      state: "pending",
      active: true,
      createdAt: "2026-08-26T00:00:00.000Z",
    },
  },
  session: {
    sessionId: "10000000-0000-4000-8000-000000000003",
    projectId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    title: "导出 / 会话",
    state: "idle",
    executionMode: "elastic",
    workingDirectory: "/workspace",
    workspaceState: "attached",
    sandboxProfileKey: "standard",
    modelProfileId: "10000000-0000-4000-8000-000000000009",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:01:00.000Z",
    lastActiveAt: "2026-08-26T00:01:00.000Z",
  },
  inheritedMessages: [],
  turns: [
    {
      runId: "10000000-0000-4000-8000-000000000004",
      turnId: "10000000-0000-4000-8000-000000000005",
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
      mailboxPosition: 2,
      prompt: "尚未完成的消息",
      state: "running",
      acceptedAt: "2026-08-26T00:02:00.000Z",
    },
  ],
  historyTruncated: false,
};

describe("canonical conversation Markdown export", () => {
  it("exports a large code payload without spreading every backtick run into function arguments", () => {
    const value = "`a` ".repeat(70_000);
    const withCode: ConversationDetailResource = {
      ...conversation,
      turns: [
        {
          ...conversation.turns[0]!,
          transcript: {
            ...conversation.turns[0]!.transcript!,
            items: [
              {
                kind: "tool",
                toolCallId: "large-write",
                toolName: "write",
                input: { path: "fixture.js", content: value },
                output: "done",
                status: "completed",
                firstSequence: 1,
                lastSequence: 2,
                startedAt: "2026-08-26T00:00:00.000Z",
              },
            ],
          },
        },
      ],
    };
    expect(conversationExportMarkdown(withCode, new Date("2026-08-26T00:00:00.000Z"))).toContain(
      value,
    );
  });
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
