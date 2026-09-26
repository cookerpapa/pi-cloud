import sharp from "sharp";
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_DECODE_PIXELS,
  MAX_IMAGE_INPUT_BYTES,
} from "@pi-cloud/protocol";
import type { ReadImageProcessor } from "@earendil-works/pi-agent-core";

/** Codex 40e5de9's patch-grid sizing, expressed through Pi's public processor port. */
export function imageDimensions(width: number, height: number, original: boolean) {
  const maxDimension = original ? 6000 : 2048,
    maxPatches = original ? 10000 : 2500;
  const fits = (w: number, h: number) =>
    w <= maxDimension && h <= maxDimension && Math.ceil(w / 32) * Math.ceil(h / 32) <= maxPatches;
  if (fits(width, height)) return { width, height };
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));
  if (fits(width, height)) return { width, height };
  let gridScale = Math.sqrt((32 * 32 * maxPatches) / width / height);
  const pw = (width * gridScale) / 32,
    ph = (height * gridScale) / 32;
  gridScale *= Math.min(Math.floor(pw) / pw, Math.floor(ph) / ph);
  return {
    width: Math.max(1, Math.floor(width * gridScale)),
    height: Math.max(1, Math.floor(height * gridScale)),
  };
}

export const processReadImage: ReadImageProcessor = async (bytes, _mime, options) => {
  try {
    if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new Error("Image input exceeds 64 MiB");
    const source = sharp(bytes, {
      limitInputPixels: MAX_IMAGE_DECODE_PIXELS,
      animated: false,
      failOn: "error",
    });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");
    const dimensions = imageDimensions(metadata.width, metadata.height, !options.autoResizeImages);
    // Re-encode even unscaled inputs, bounding bit depth and stripping metadata.
    const pipeline = source
      .resize(dimensions.width, dimensions.height, { fit: "fill", withoutEnlargement: true })
      .toColourspace("srgb");
    const output = await pipeline.png().toBuffer();
    if (output.length > MAX_IMAGE_ATTACHMENT_BYTES)
      throw new Error("Normalized image exceeds 42 MiB");
    const mimeType = "image/png";
    return {
      ok: true,
      data: output.toString("base64"),
      mimeType,
      hints: [
        `Image ${metadata.width}x${metadata.height}; model receives ${dimensions.width}x${dimensions.height}.`,
      ],
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Image decoding failed" };
  }
};
