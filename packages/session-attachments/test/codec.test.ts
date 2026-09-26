import { randomBytes, randomUUID, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ImageAttachmentCodec, type ImageAttachmentStore } from "../src/codec.ts";
import type { ImageAttachmentReference } from "@pi-cloud/protocol";

function fixture() {
  const objects = new Map<string, Buffer>();
  const store: ImageAttachmentStore = {
    put: vi.fn(async (scope, bytes, mimeType) => {
      const ref: ImageAttachmentReference = {
        id: randomUUID(),
        mimeType,
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      objects.set(scope.tenantId + ref.id, Buffer.from(bytes));
      return ref;
    }),
    get: vi.fn(async (tenant, ref, signal) => {
      signal?.throwIfAborted();
      const bytes = objects.get(tenant + ref.id);
      if (!bytes) throw new Error("missing");
      return bytes;
    }),
  };
  const codec = new ImageAttachmentCodec(store),
    scope = { tenantId: randomUUID(), runId: randomUUID() };
  const image = {
    type: "image" as const,
    data: randomBytes(3 * 1024 * 1024).toString("base64"),
    mimeType: "image/png",
  };
  return { codec, scope, store, image, objects };
}
it("externalizes image bytes across reply, final native record and compaction without altering content", async () => {
  const f = fixture();
  const native = {
    content: [{ type: "text", text: "screenshot" }, f.image],
    details: { source: "native" },
  };
  const packed = await f.codec.pack(f.scope, native);
  expect(JSON.stringify(packed).length).toBeLessThan(1024);
  const reader = new ImageAttachmentCodec(f.store);
  const restored = await reader.unpack<typeof native>(f.scope, packed);
  expect(restored).toEqual(native);
  const canonical = await reader.pack(f.scope, {
    type: "compaction",
    retainedTail: [{ role: "toolResult", ...restored }],
  });
  expect(JSON.stringify(canonical).length).toBeLessThan(1024);
  expect(f.store.put).toHaveBeenCalledTimes(1);
});
it("after-hook image changes get a different immutable attachment", async () => {
  const f = fixture();
  const first = await f.codec.pack(f.scope, f.image);
  const native = await f.codec.unpack<typeof f.image>(f.scope, first);
  native.data = Buffer.from("different image bytes").toString("base64");
  const second = await f.codec.pack(f.scope, native);
  expect(second.attachment.id).not.toBe(first.attachment.id);
  expect(f.store.put).toHaveBeenCalledTimes(2);
});
it("rejects another tenant, corruption, cancellation and guest-provided references", async () => {
  const f = fixture(),
    packed = await f.codec.pack(f.scope, f.image);
  await expect(f.codec.unpack({ tenantId: randomUUID() }, packed)).rejects.toThrow("missing");
  const signal = AbortSignal.abort(new Error("cancelled"));
  await expect(f.codec.unpack(f.scope, packed, signal)).rejects.toThrow("cancelled");
  await expect(f.codec.pack(f.scope, packed)).rejects.toThrow("cannot originate");
  f.objects.set(f.scope.tenantId + packed.attachment.id, Buffer.from("corrupt"));
  await expect(f.codec.unpack(f.scope, packed)).rejects.toThrow("integrity");
});
it("upload failure never produces an image reference", async () => {
  const f = fixture();
  vi.mocked(f.store.put).mockRejectedValue(new Error("upload failed"));
  await expect(f.codec.pack(f.scope, f.image)).rejects.toThrow("upload failed");
});
it("preserves image-shaped opaque Tool details and arguments without uploading them", async () => {
  const f = fixture();
  const value = {
    content: [{ type: "text", text: "ordinary result" }],
    details: { example: f.image },
    arguments: { example: { type: "pi_cloud_image_v1", attachment: { url: "example" } } },
  };
  const packed = await f.codec.pack(f.scope, value);
  expect(packed).toEqual(value);
  expect(await f.codec.unpack(f.scope, packed)).toEqual(value);
  expect(f.store.put).not.toHaveBeenCalled();
  expect(f.store.get).not.toHaveBeenCalled();
});
