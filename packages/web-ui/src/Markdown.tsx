import { memo, type ReactNode } from "react";
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
      port === 49_984
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
        a: ({ children, href }) => (
          <a
            href={conversationPreviewHref(href, sessionId)}
            rel="noreferrer noopener"
            target="_blank"
          >
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

export function Markdown({
  children,
  sessionId,
}: {
  children: string;
  sessionId?: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="product-markdown">
      <StableMarkdownBody sessionId={sessionId} t={t} text={children} />
    </div>
  );
}
