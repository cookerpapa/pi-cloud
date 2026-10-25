import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConversationTurn } from "../src/ConversationTurn.tsx";
import { deriveConversationPresentationRows } from "../src/conversation-presentation.ts";
import { inlineToolImages } from "../src/ToolImages.tsx";
import { ToolActivity, type ToolTranscriptItem } from "../src/ToolActivity.tsx";
import type { TurnView } from "../src/session-view.ts";
const id = "10000000-0000-4000-8000-000000000002";
const image = {
  type: "image",
  imageId: id,
  mimeType: "image/png",
  previewPath: `/v1/sessions/10000000-0000-4000-8000-000000000001/images/${id}`,
};
const tool = (key: string, name = "show_image"): ToolTranscriptItem => ({
  kind: "tool",
  key,
  toolCallId: key,
  toolName: name,
  input: { path: "/workspace/private-path.png", caption: "页面效果 <script>" },
  output: {
    content: [{ type: "text", text: "Image ready" }, image],
    details: { imageCaption: "页面效果 <script>" },
  },
  status: "completed",
  startedAt: "2026-10-25T00:00:00Z",
  completedAt: "2026-10-25T00:00:01Z",
  firstSequence: 2,
  lastSequence: 3,
});
function turn(items: ToolTranscriptItem[]): TurnView {
  return {
    runId: "run",
    turnId: "turn",
    mailboxPosition: null,
    prompt: "展示截图",
    acceptedAt: null,
    status: "completed",
    startedSequence: 1,
    terminalSequence: 6,
    stopReason: "stop",
    failure: null,
    cancellation: null,
    items,
  };
}
it.each(["show_image", "generate_image"])(
  "presents %s outside collapsed activities with no duplicate in Tool details",
  (name) => {
    const images = tool("show", name);
    const rows = deriveConversationPresentationRows([
      tool("before", "bash"),
      images,
      tool("after", "read"),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["activity", "images", "activity"]);
    const html = renderToStaticMarkup(
      <ConversationTurn turn={turn([tool("before", "bash"), images, tool("after", "read")])} />,
    );
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('class="product-tool-images"');
    expect(html).toContain("页面效果 &lt;script&gt;");
    expect(html).not.toContain("<script>");
  },
);
it("does not display model-only Read images, running results or failed snapshots", () => {
  expect(inlineToolImages(tool("read", "read"))).toEqual([]);
  expect(inlineToolImages({ ...tool("show"), status: "running" })).toEqual([]);
  expect(inlineToolImages({ ...tool("show"), status: "failed" })).toEqual([]);
  expect(
    inlineToolImages({
      ...tool("show"),
      output: { details: { generatedImage: { previewPath: image.previewPath } } },
    }),
  ).toEqual([]);
});
it("keeps separate intentional display invocations even when they reference the same image", () => {
  const html = renderToStaticMarkup(
    <ConversationTurn turn={turn([tool("first"), tool("second")])} />,
  );
  expect(html.match(/<img /g)).toHaveLength(2);
});

it("defers closed technical details without repeating the image", () => {
  const html = renderToStaticMarkup(<ToolActivity item={tool("shown")} />);
  expect(html).not.toContain("private-path.png");
  expect(html).not.toContain("caption");
  expect(html).toContain("<details>");
  expect(html).not.toContain("<img");
});
