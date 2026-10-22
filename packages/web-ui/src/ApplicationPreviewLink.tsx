import type { TranscriptItem } from "./session-view.ts";
import { useI18n } from "./i18n.tsx";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function applicationPreview(item: ToolItem): { path: string; port: number } | undefined {
  if (item.toolName !== "preview" || item.status !== "completed") return undefined;
  const details = record(record(item.output)?.details);
  const path = details?.previewPath;
  const port = details?.port;
  const route =
    typeof path === "string" ? /^\/v1\/conversations\/[^/?#]+\/preview\/(\d+)\//.exec(path) : null;
  if (
    typeof path !== "string" ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    route === null ||
    Number(route[1]) !== port
  )
    return undefined;
  return { path, port };
}

/** Result navigation remains visible independently of invocation disclosure. */
export function ApplicationPreviewLink({ item }: { item: ToolItem }) {
  const { t } = useI18n();
  const preview = applicationPreview(item);
  return preview ? (
    <a className="product-preview-tool-link" href={preview.path} rel="noreferrer" target="_blank">
      <span aria-hidden="true">↗</span>
      {t("turn.previewOpen", { port: preview.port })}
    </a>
  ) : null;
}
