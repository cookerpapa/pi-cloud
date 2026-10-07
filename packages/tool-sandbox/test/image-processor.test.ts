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

// Four distinct corners make mirror errors visible even when dimensions agree.
const colors = [
  [240, 20, 20],
  [20, 230, 20],
  [20, 20, 240],
  [240, 230, 20],
];
const corners = [
  [0, 1, 2, 3],
  [1, 0, 3, 2],
  [3, 2, 1, 0],
  [2, 3, 0, 1],
  [0, 2, 1, 3],
  [2, 0, 3, 1],
  [3, 1, 2, 0],
  [1, 3, 0, 2],
];
it.each([true, false])(
  "preserves all eight EXIF corner orientations (resize=%s)",
  async (autoResizeImages) => {
    const width = 80,
      height = 40,
      pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        pixels.set(
          colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]!,
          (y * width + x) * 3,
        );
    for (let orientation = 1; orientation <= 8; orientation++) {
      const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
        .withMetadata({ orientation })
        .toBuffer();
      const result = await processReadImage(jpeg, "image/jpeg", { autoResizeImages });
      if (!result.ok) throw new Error(result.message);
      const output = Buffer.from(result.data, "base64"),
        metadata = await sharp(output).metadata();
      const w = orientation >= 5 ? height : width,
        h = orientation >= 5 ? width : height;
      expect([metadata.width, metadata.height, metadata.orientation]).toEqual([w, h, undefined]);
      const decoded = await sharp(output).removeAlpha().raw().toBuffer();
      for (let corner = 0; corner < 4; corner++) {
        const x = corner % 2 ? w - 8 : 8,
          y = corner >= 2 ? h - 8 : 8;
        const color = colors[corners[orientation - 1]![corner]!]!;
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(decoded[(y * w + x) * 3 + channel]! - color[channel]!)).toBeLessThan(5);
      }
      expect(result.hints).toContain(`Image ${w}x${h}; model receives ${w}x${h}.`);
    }
  },
);
