import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import { ImageGenerationClient } from "../src/ordinary-tools/image-generation-client.ts";
import type { ImageAttachmentReference } from "@pi-cloud/protocol";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import { createImageTool } from "../src/ordinary-tools/image-tool.ts";
import { ControlToolRegistry } from "../src/control-tool-registry.ts";

function fixture() {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const objects = new Map<string, Buffer>();
  const store = {
    async put(_scope: unknown, bytes: Buffer) {
      const ref: ImageAttachmentReference = {
        id: randomUUID(),
        mimeType: "image/png",
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      objects.set(ref.id, bytes);
      return ref;
    },
    async get(_tenant: string, ref: ImageAttachmentReference) {
      return objects.get(ref.id)!;
    },
  };
  const codec = new ImageAttachmentCodec(store);
  const generate = vi.fn<ImageGenerationClient["generate"]>(async () => ({
    data: png.toString("base64"),
    mimeType: "image/png" as const,
  }));
  const imageIo = vi.fn(async (_command: AcceptedControlToolCommand, action: { kind: string }) => ({
    toolBrokerProtocolVersion: 1 as const,
    type: "tool_sandbox.image_io_result" as const,
    requestId: randomUUID(),
    activationId: randomUUID(),
    image: await store.put({}, png),
    ...(action.kind === "save" ? { path: "/workspace/generated_images/result.png" } : {}),
  }));
  const recentImages = vi.fn(async () => [await store.put({}, png)]);
  const registry = new ControlToolRegistry();
  registry.register(
    createImageTool({
      database: {} as Kysely<Database>,
      images: { codec, store },
      client: { generate },
      imageIo,
      recentImages,
    }),
  );
  const command = {
    toolName: "generate_image",
    nativeCallId: "call",
    operationId: randomUUID(),
    bindingId: randomUUID(),
    scope: { tenantId: randomUUID(), runId: randomUUID(), sessionId: randomUUID() },
  } as AcceptedControlToolCommand;
  const execute = (args: Record<string, unknown>) =>
    registry.execute({ ...command, arguments: args }, () => true, new AbortController().signal);
  return { registry, generate, imageIo, recentImages, execute };
}
it("advertises a non-replayable Tool with Codex's four arguments and returns a visible image", async () => {
  const f = fixture();
  expect(Object.keys(f.registry.read().tools[0]!.parameters.properties as object)).toEqual([
    "prompt",
    "referenced_image_paths",
    "num_last_images_to_include",
    "transparent_background",
  ]);
  expect(f.registry.replayable("generate_image")).toBe(false);
  const output = await f.execute({ prompt: "Create a character", transparent_background: true });
  expect(f.generate).toHaveBeenCalledWith(
    { prompt: "Create a character", images: [], transparent: true },
    expect.any(AbortSignal),
  );
  expect(output.result.content.some((p) => p.type === "image")).toBe(true);
  expect(output.result.details).toMatchObject({
    generatedImage: { fileSaved: true, referenceCount: 0 },
  });
});
it("uses either explicit Sandbox paths or frozen Conversation images", async () => {
  const f = fixture();
  await f.execute({ prompt: "Use these references", referenced_image_paths: ["a.png", "b.png"] });
  expect(f.generate.mock.calls[0]?.[0]).toMatchObject({
    images: [{ mimeType: "image/png" }, { mimeType: "image/png" }],
  });
  expect(f.recentImages).not.toHaveBeenCalled();
  const g = fixture();
  await g.execute({ prompt: "Use the last picture", num_last_images_to_include: 1 });
  expect(g.recentImages).toHaveBeenCalledTimes(1);
  expect(g.imageIo).toHaveBeenCalledTimes(1);
  expect(g.imageIo.mock.calls[0]?.[1]).toMatchObject({ kind: "save" });
});
it("rejects incompatible and unavailable references before sending a generation request", async () => {
  const f = fixture();
  const result = await f.execute({
    prompt: "edit",
    referenced_image_paths: ["a.png"],
    num_last_images_to_include: 1,
  });
  expect(result.isError).toBe(true);
  expect(f.generate).not.toHaveBeenCalled();
  f.recentImages.mockRejectedValueOnce(new Error("Missing image"));
  expect((await f.execute({ prompt: "edit", num_last_images_to_include: 1 })).isError).toBe(true);
  expect(f.generate).not.toHaveBeenCalled();
});
it("retains the generated pixels when Workspace placement fails without regenerating", async () => {
  const f = fixture();
  const io = f.imageIo.getMockImplementation()!;
  f.imageIo.mockImplementationOnce(async (...args) => {
    const result = await io(...args);
    const { path: _path, ...withoutFile } = result;
    return { ...withoutFile, placementError: "Workspace unavailable" };
  });
  const result = await f.execute({ prompt: "a character" });
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(result.result.content.some((p) => p.type === "image")).toBe(true);
  expect(result.result.details).toMatchObject({ generatedImage: { fileSaved: false } });
});

it("does not put an unvalidated provider image into native context after guest decoding fails", async () => {
  const f = fixture();
  f.imageIo.mockRejectedValueOnce(new Error("Image decode failed"));
  const result = await f.execute({ prompt: "a character" });
  expect(result.isError).toBe(true);
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(result.result.content.some((part) => part.type === "image")).toBe(false);
});

it("refuses an oversized combined reference set before contacting the image service", async () => {
  const f = fixture();
  f.recentImages.mockResolvedValueOnce([
    {
      id: crypto.randomUUID(),
      sha256: "a".repeat(64),
      byteLength: 65 * 1024 * 1024,
      mimeType: "image/png",
    },
  ]);
  const result = await f.execute({ prompt: "edit", num_last_images_to_include: 1 });
  expect(result.isError).toBe(true);
  expect(f.generate).not.toHaveBeenCalled();
});

it("passes the provider's rejection reason to the Agent as a Tool error without creating an image", async () => {
  const f = fixture();
  const send = vi.fn(async () =>
    Response.json(
      {
        error: {
          code: "moderation_blocked",
          message: "The generated output did not pass moderation.",
          moderation_details: { moderation_stage: "output", categories: ["sexual"] },
        },
      },
      { status: 400 },
    ),
  );
  const client = new ImageGenerationClient({
    baseUrl: "http://fixture",
    apiKey: "test-key",
    model: "gpt-image-2",
    fetch: send,
  });
  f.generate.mockImplementation((...args) => client.generate(...args));
  try {
    const result = await f.execute({ prompt: "A landscape" });
    expect(result.isError).toBe(true);
    expect(result.result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("image_generation_failed: Image service returned HTTP 400"),
      },
    ]);
    const text = result.result.content[0];
    expect(text?.type === "text" && text.text).toContain('"code":"moderation_blocked"');
    expect(text?.type === "text" && text.text).toContain("did not pass moderation");
    expect(text?.type === "text" && text.text).toContain('"moderationStage":"output"');
    expect(text?.type === "text" && text.text).toContain('"moderationCategories":["sexual"]');
    expect(f.imageIo).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
  }
});
