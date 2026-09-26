import { expect, it } from "vitest";
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { imageDimensions, processReadImage } from "../src/image-processor.ts";

it("matches Codex high/original patch-grid examples", () => {
  expect(imageDimensions(2048, 2048, false)).toEqual({ width: 1600, height: 1600 });
  expect(imageDimensions(3840, 2160, false)).toEqual({ width: 2048, height: 1152 });
  expect(imageDimensions(3840, 2160, true)).toEqual({ width: 3840, height: 2160 });
  expect(imageDimensions(6401, 100, true)).toEqual({ width: 6000, height: 94 });
  expect(imageDimensions(3201, 3201, true)).toEqual({ width: 3200, height: 3200 });
});
it("processes an image larger than the former 2 MiB file limit and strips metadata", async () => {
  const source = await sharp(randomBytes(1000 * 1000 * 3), {
    raw: { width: 1000, height: 1000, channels: 3 },
  })
    .png()
    .withMetadata()
    .toBuffer();
  expect(source.length).toBeGreaterThan(2 * 1024 * 1024);
  const result = await processReadImage(source, "image/png", { autoResizeImages: true });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  const meta = await sharp(Buffer.from(result.data, "base64")).metadata();
  expect(meta.width).toBe(1000);
  expect(meta.height).toBe(1000);
  expect(meta.exif).toBeUndefined();
});
it("rejects malformed input visibly", async () => {
  expect(
    await processReadImage(Buffer.from("broken"), "image/png", { autoResizeImages: true }),
  ).toMatchObject({ ok: false });
});
it("normalizes 16-bit inputs to bounded 8-bit PNG without lossy JPEG re-encoding", async () => {
  const source = await sharp({
    create: { width: 80, height: 40, channels: 3, background: "#547ab6" },
  })
    .toColourspace("rgb16")
    .png()
    .toBuffer();
  expect((await sharp(source).metadata()).depth).toBe("ushort");
  const result = await processReadImage(source, "image/png", { autoResizeImages: false });
  if (!result.ok) throw new Error(result.message);
  expect((await sharp(Buffer.from(result.data, "base64")).metadata()).depth).toBe("uchar");
});
