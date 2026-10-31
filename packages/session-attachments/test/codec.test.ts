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
it("fetches repeated immutable images once per decode and does not retain a cross-request byte cache", async () => {
  const f = fixture();
  const packed = await f.codec.pack(f.scope, [f.image, { ...f.image, label: "again" }]);
  expect(await f.codec.unpack(f.scope, packed)).toEqual([f.image, { ...f.image, label: "again" }]);
  expect(f.store.get).toHaveBeenCalledTimes(1);
  await f.codec.unpack(f.scope, packed);
  expect(f.store.get).toHaveBeenCalledTimes(2);
  await expect(f.codec.unpack({ tenantId: randomUUID() }, packed)).rejects.toThrow("missing");
});
it("does not let repeated identities bypass changed metadata or cancellation during a read", async () => {
  const f = fixture(),
    packed = await f.codec.pack(f.scope, f.image);
  await expect(
    f.codec.unpack(f.scope, [
      packed,
      {
        ...packed,
        attachment: { ...packed.attachment, byteLength: packed.attachment.byteLength + 1 },
      },
    ]),
  ).rejects.toThrow("integrity");
  expect(f.store.get).toHaveBeenCalledTimes(2);
  const abort = new AbortController();
  vi.mocked(f.store.get).mockImplementationOnce(async () => {
    abort.abort(new Error("cancelled during fetch"));
    return Buffer.from(f.image.data, "base64");
  });
  await expect(f.codec.unpack(f.scope, packed, abort.signal)).rejects.toThrow(
    "cancelled during fetch",
  );
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

it("observes unique image reads without extra fetches or exposing bytes and ignores observer failure", async () => {
  const f = fixture(),
    observed = vi.fn();
  const packed = await f.codec.pack(f.scope, [f.image, f.image]);
  const codec = new ImageAttachmentCodec(f.store, () => observed);
  expect(await codec.unpack(f.scope, packed)).toEqual([f.image, f.image]);
  expect(f.store.get).toHaveBeenCalledOnce();
  expect(observed).toHaveBeenCalledOnce();
  expect(observed.mock.calls[0]).toEqual([
    { outcome: "completed", durationMs: expect.any(Number), byteLength: 3 * 1024 * 1024 },
  ]);
  observed.mockImplementation(() => {
    throw new Error("sink broke");
  });
  expect(await codec.unpack(f.scope, packed)).toEqual([f.image, f.image]);
  const failure = new Error("read failed");
  vi.mocked(f.store.get).mockRejectedValueOnce(failure);
  await expect(codec.unpack(f.scope, packed)).rejects.toBe(failure);
  expect(observed.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: "failed", byteLength: 0 });
  const noObserver = new ImageAttachmentCodec(f.store, () => {
    throw new Error("capture broke");
  });
  expect(await noObserver.unpack(f.scope, packed)).toEqual([f.image, f.image]);
});
it("classifies cancellation during image reading without accepting partial bytes", async () => {
  const f = fixture(),
    abort = new AbortController(),
    observed = vi.fn();
  const packed = await f.codec.pack(f.scope, f.image);
  const original = f.store.get;
  f.store.get = async (...args) => {
    const bytes = await original(...args);
    abort.abort(new Error("stopped"));
    return bytes;
  };
  await expect(
    new ImageAttachmentCodec(f.store, () => observed).unpack(f.scope, packed, abort.signal),
  ).rejects.toThrow("stopped");
  expect(observed).toHaveBeenCalledOnce();
  expect(observed.mock.calls[0]?.[0]).toMatchObject({ outcome: "cancelled" });
});
