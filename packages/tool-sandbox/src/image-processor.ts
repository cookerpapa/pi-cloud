import sharp from "sharp";
export type ReadImageResult =
  { ok: true; data: string; mimeType: string; hints: string[] } | { ok: false; message: string };
export type ReadImageProcessor = (
  bytes: Uint8Array,
  mimeType: string,
  options: { autoResizeImages: boolean },
) => Promise<ReadImageResult>;

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

export const processReadImage: ReadImageProcessor = (bytes, _mime, options) =>
  processImageSource(bytes, options);
export async function processImageSource(
  bytes: Uint8Array | string,
  options: { autoResizeImages: boolean },
): ReturnType<ReadImageProcessor> {
  try {
    const source = sharp(bytes, {
      limitInputPixels: false,
      animated: false,
      failOn: "error",
    });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");
    const { width, height } = metadata.autoOrient;
    const dimensions = imageDimensions(width, height, !options.autoResizeImages);
    // Apply display geometry before sizing or removing its EXIF metadata.
    const pipeline = source
      .autoOrient()
      .resize(dimensions.width, dimensions.height, { fit: "fill", withoutEnlargement: true })
      .toColourspace("srgb");
    const { data: output, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
    const mimeType = "image/png";
    return {
      ok: true,
      data: output.toString("base64"),
      mimeType,
      hints: [`Image ${width}x${height}; model receives ${info.width}x${info.height}.`],
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Image decoding failed" };
  }
}
