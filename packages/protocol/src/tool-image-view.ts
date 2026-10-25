import { parseImageAttachmentReference } from "./image-attachment.ts";

/** Public presentation data, never native image bytes or an executor's guessed URL. */
export type ToolImageView = {
  type: "image";
  imageId: string;
  previewPath: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
};

export function toolImageView(sessionId: string, packed: unknown): ToolImageView {
  if (
    !packed ||
    typeof packed !== "object" ||
    (packed as { type?: string }).type !== "pi_cloud_image_v1"
  )
    throw new Error("Image presentation requires a canonical attachment reference");
  const image = parseImageAttachmentReference((packed as { attachment?: unknown }).attachment);
  return {
    type: "image",
    imageId: image.id,
    mimeType: image.mimeType,
    previewPath: `/v1/sessions/${encodeURIComponent(sessionId)}/images/${image.id}`,
  };
}

export function toolContentView(sessionId: string, content: readonly unknown[]): unknown[] {
  return content.map((part) => {
    if (part && typeof part === "object") {
      const image = part as { type?: string; data?: unknown };
      if (image.type === "pi_cloud_image_v1") return toolImageView(sessionId, part);
      if (image.type === "image" && typeof image.data === "string")
        throw new Error("Inline pixels cannot become public Tool presentation");
    }
    return part;
  });
}
