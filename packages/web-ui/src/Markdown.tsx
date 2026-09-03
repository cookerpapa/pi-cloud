import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { useI18n, type Translate } from "./i18n.tsx";

export function conversationPreviewHref(
  href: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (href === undefined || sessionId === undefined) return href;
  try {
    const target = new URL(href);
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    if (
      target.protocol !== "http:" ||
      !new Set(["localhost", "127.0.0.1", "0.0.0.0"]).has(target.hostname) ||
      !Number.isSafeInteger(port) ||
      port < 1_024 ||
      port > 65_535 ||
      port === 49_983
    ) {
      return href;
    }
    return `/v1/conversations/${encodeURIComponent(sessionId)}/preview/${String(port)}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return href;
  }
}

function MarkdownCode({ className, children }: { className?: string; children?: ReactNode }) {
  const text = String(children ?? "").replace(/\n$/u, "");
  const language = /(?:^|\s)language-([^\s]+)/u.exec(className ?? "")?.[1] ?? null;
  if (language === null) return <code className={className}>{children}</code>;
  return (
    <HighlightedCode
      language={language}
      text={text}
      {...(className === undefined ? {} : { className })}
    />
  );
}

const StableMarkdownBody = memo(function StableMarkdownBody({
  text,
  sessionId,
  t,
}: {
  text: string;
  sessionId: string | undefined;
  t: Translate;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => {
          const resolved = conversationPreviewHref(href, sessionId);
          const previewPort =
            resolved !== href
              ? /\/preview\/([0-9]{4,5})(?:\/|$)/u.exec(resolved ?? "")?.[1]
              : undefined;
          const childText =
            typeof children === "string"
              ? children
              : Array.isArray(children) && children.every((child) => typeof child === "string")
                ? children.join("")
                : undefined;
          return (
            <a href={resolved} rel="noreferrer noopener" target="_blank">
              {previewPort !== undefined && childText === href
                ? t("turn.openPreview", { port: previewPort })
                : children}
            </a>
          );
        },
        code: ({ className, children }) => (
          <MarkdownCode {...(className === undefined ? {} : { className })}>
            {children}
          </MarkdownCode>
        ),
        img: ({ alt }) => (
          <span className="product-image-placeholder">{t("turn.image", { alt: alt ?? "" })}</span>
        ),
        table: ({ children }) => (
          <div className="product-markdown-table-scroll">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

export function streamingMarkdownBlocks(text: string): readonly string[] {
  if (text.length === 0) return [];
  if (/^\s*\[[^\]]+\]:\s*\S+/mu.test(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let fence: "```" | "~~~" | null = null;
  for (const match of text.matchAll(/.*(?:\n|$)/gu)) {
    const line = match[0];
    if (line.length === 0) continue;
    offset += line.length;
    const trimmed = line.trimStart();
    if (fence === null) {
      if (trimmed.startsWith("```")) fence = "```";
      else if (trimmed.startsWith("~~~")) fence = "~~~";
    } else if (trimmed.startsWith(fence)) {
      fence = null;
    }
    if (fence === null && /^\s*$/u.test(line)) {
      blocks.push(text.slice(start, offset));
      start = offset;
    }
  }
  if (start < text.length) blocks.push(text.slice(start));
  return blocks;
}

export function Markdown({
  children,
  sessionId,
  streaming = false,
}: {
  children: string;
  sessionId?: string | undefined;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  const blocks = useMemo(
    () => (streaming ? streamingMarkdownBlocks(children) : [children]),
    [children, streaming],
  );
  return (
    <div className="product-markdown">
      {blocks.map((block, index) => (
        <StableMarkdownBody
          key={streaming ? `stream-block:${String(index)}` : "final"}
          sessionId={sessionId}
          t={t}
          text={block}
        />
      ))}
    </div>
  );
}
