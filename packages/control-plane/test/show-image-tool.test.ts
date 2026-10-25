import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import type { ImageAttachmentReference } from "@pi-cloud/protocol";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import { createShowImageTool } from "../src/ordinary-tools/image-tool.ts";
import { ControlToolRegistry } from "../src/control-tool-registry.ts";

function fixture() {
  const bytes = Buffer.from("guest-normalized-image");
  const ref: ImageAttachmentReference = {
    id: randomUUID(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    mimeType: "image/png",
  };
  const store = {
    async get() {
      return bytes;
    },
    async put() {
      throw new Error("Must reuse the guest's attachment");
    },
  };
  const codec = new ImageAttachmentCodec(store);
  const imageIo = vi.fn(async () => ({
    toolBrokerProtocolVersion: 1 as const,
    type: "tool_sandbox.image_io_result" as const,
    requestId: randomUUID(),
    activationId: randomUUID(),
    image: ref,
  }));
  const tool = createShowImageTool({ images: { codec, store }, imageIo });
  const registry = new ControlToolRegistry();
  registry.register(tool);
  const command: AcceptedControlToolCommand = {
    kind: "control_tool",
    target: "control",
    taskId: 2,
    conversationId: 1,
    contextAnchor: null,
    replyTopic: "test-replies",
    nativeSequence: 1,
    toolName: "show_image",
    nativeCallId: "call",
    operationId: randomUUID(),
    bindingId: randomUUID(),
    scope: {
      tenantId: randomUUID(),
      runId: randomUUID(),
      sessionId: randomUUID(),
      turnId: randomUUID(),
      piSessionId: randomUUID(),
      writerId: randomUUID(),
      fencingToken: 1,
    },
    arguments: { path: "/workspace/screenshot.png", caption: "  页面效果  " },
  };
  return { command, tool, registry, imageIo, bytes };
}
it("registers without any image provider and returns a native image plus a plain caption", async () => {
  const f = fixture();
  expect(f.registry.read().tools.map((t) => t.name)).toEqual(["show_image"]);
  expect(f.registry.replayable("show_image")).toBe(false);
  const result = await f.registry.execute(f.command, () => true);
  expect(f.imageIo).toHaveBeenCalledWith(
    f.command,
    { kind: "read", path: f.command.arguments.path },
    expect.any(AbortSignal),
  );
  expect(result.result).toMatchObject({
    details: { imageCaption: "页面效果" },
    content: [
      { type: "text" },
      { type: "image", data: f.bytes.toString("base64"), mimeType: "image/png" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("previewPath");
});
it("rejects malformed arguments and reports an unreadable image without inventing a preview", async () => {
  const f = fixture();
  expect((await f.registry.execute({ ...f.command, arguments: {} }, () => true)).isError).toBe(
    true,
  );
  expect(f.imageIo).not.toHaveBeenCalled();
  f.imageIo.mockRejectedValueOnce(new Error("missing file"));
  const result = await f.registry.execute(f.command, () => true);
  expect(result.isError).toBe(true);
  expect(result.result.content.some((p) => p.type === "image")).toBe(false);
});
it("does not publish a display after cancellation while the image is being read", async () => {
  const f = fixture(),
    abort = new AbortController();
  const completed = Promise.withResolvers<Awaited<ReturnType<typeof f.imageIo>>>();
  const original = f.imageIo.getMockImplementation()!;
  f.imageIo.mockImplementationOnce(() => completed.promise);
  const call = f.registry.execute(f.command, () => true, abort.signal);
  abort.abort(new Error("stopped"));
  completed.resolve(await original());
  await expect(call).rejects.toThrow("stopped");
});
