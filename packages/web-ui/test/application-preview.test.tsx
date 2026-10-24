import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { createPiCloudEventFactory, resolveDurableDisplay } from "@pi-cloud/protocol";
import { ConversationTurn } from "../src/ConversationTurn.tsx";
import type { ToolTranscriptItem } from "../src/ToolActivity.tsx";
import type { TurnView } from "../src/session-view.ts";

const path = "/v1/conversations/10000000-0000-4000-8000-000000000001/preview/5173/";
const details = { port: 5173, previewPath: path };
const preview: ToolTranscriptItem = {
  kind: "tool",
  key: "preview",
  toolCallId: "task:2",
  toolName: "preview",
  input: { port: 5173 },
  status: "completed",
  startedAt: "2026-10-22T00:00:00.000Z",
  firstSequence: 2,
  lastSequence: 3,
};
function rendered(output: unknown, answer = `已完成：[进入示例应用](${path})`) {
  const turn: TurnView = {
    runId: "run",
    turnId: "turn",
    mailboxPosition: null,
    prompt: "Build a web app",
    acceptedAt: null,
    status: "completed",
    startedSequence: 1,
    terminalSequence: 5,
    stopReason: "stop",
    failure: null,
    cancellation: null,
    items: [
      { ...preview, key: "bash", toolCallId: "task:1", toolName: "bash", output: "ready" },
      { ...preview, output },
      { kind: "text", key: "final", text: answer, firstSequence: 4, lastSequence: 4 },
    ],
  };
  return renderToStaticMarkup(<ConversationTurn turn={turn} />);
}

it("renders the answer link once with Tool steps collapsed for live and cold results", () => {
  const event = createPiCloudEventFactory({
    sessionId: "session",
    turnId: "turn",
    agentId: "root",
  }).next({ type: "tool.completed", payload: { toolCallId: "task:2", outcome: "completed" } });
  if (event.type !== "tool.completed") throw new Error("fixture");
  const commit = {
    seq: 1,
    nextId: 2,
    writes: [{ type: "entry", value: { text: "Published", details } }],
  };
  const live = resolveDurableDisplay(
    commit,
    {
      event,
      output: {
        kind: "parts",
        maximumBytes: 65536,
        parts: [{ kind: "write", ordinal: 0, path: ["value", "text"], start: 0, end: 9 }],
        details: { kind: "write", ordinal: 0, path: ["value", "details"] },
      },
    },
    () => undefined,
  );
  if (live.type !== "tool.completed") throw new Error("fixture");
  for (const output of [
    live.payload.output,
    { content: [{ type: "text", text: "Published" }], details },
  ]) {
    const markup = rendered(output);
    expect(markup).toContain('data-expanded="false"');
    expect(markup).toContain(path);
    expect(markup).toContain("进入示例应用");
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).not.toContain("打开应用（端口");
    expect(markup).not.toContain("product-preview-tool-link");
    expect(markup).not.toContain("product-activity-group-items");
  }
});

it("does not synthesize a fallback link when the answer omits it", () => {
  const markup = rendered(
    { content: [{ type: "text", text: `Preview: ${path}` }], details },
    "应用已完成",
  );
  expect(markup).not.toContain("<a ");
  expect(markup).not.toContain("product-preview-tool-link");
  expect(markup).not.toContain(path);
});

it("does not turn result metadata or diagnostic text into application actions", () => {
  for (const output of [
    { details },
    { content: [{ type: "text", text: "preview_service_not_found: no service on port 5173" }] },
    { details: { ...details, previewPath: "javascript:alert(1)" } },
  ]) {
    expect(rendered(output, "查看工具结果")).not.toContain("<a ");
  }
});
