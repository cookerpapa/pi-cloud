import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { useI18n, type Translate } from "./i18n.tsx";

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
  t,
}: {
  text: string;
  t: Translate;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, href }) => (
          <a href={href} rel="noreferrer noopener" target="_blank">
            {children}
          </a>
        ),
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
  streaming = false,
}: {
  children: string;
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
          t={t}
          text={block}
        />
      ))}
    </div>
  );
}
