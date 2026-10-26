import type { ToolImageView } from "@pi-cloud/protocol";
import type { ToolTranscriptItem } from "./ToolActivity.tsx";
import { SessionImage, isSessionImagePath } from "./SessionImage.tsx";
import { useI18n } from "./i18n.tsx";

const imageTools = new Set(["show_image", "generate_image", "android_observe"]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Presentation semantics, independent of the tool's execution or provider. */
export function inlineToolImages(item: ToolTranscriptItem): ToolImageView[] {
  if (item.status !== "completed" || !imageTools.has(item.toolName)) return [];
  const content = object(item.output)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is ToolImageView => {
    const image = object(part);
    return (
      image?.type === "image" &&
      typeof image.imageId === "string" &&
      isSessionImagePath(image.previewPath) &&
      image.previewPath.endsWith(`/${image.imageId}`) &&
      ["image/png", "image/jpeg", "image/webp"].includes(String(image.mimeType))
    );
  });
}

export function ToolImages({
  item,
  onLoad,
}: {
  item: ToolTranscriptItem;
  onLoad?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const caption = object(object(item.output)?.details)?.imageCaption;
  const label = typeof caption === "string" && caption.trim() ? caption : undefined;
  return (
    <div className="product-tool-images" data-image-tool-call-id={item.toolCallId}>
      {inlineToolImages(item).map((image, index) => (
        <figure className="product-image-result" key={`${image.imageId}:${index}`}>
          <SessionImage
            src={image.previewPath}
            alt={label ?? t("turn.image", { alt: "" })}
            onLoad={onLoad}
          />
          {label ? <figcaption>{label}</figcaption> : null}
        </figure>
      ))}
    </div>
  );
}
