import { memo, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
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

const markdownParser = unified().use(remarkParse).use(remarkGfm);

export function streamingMarkdownBlocks(
  text: string,
  previous?: { text: string; blocks: readonly string[] },
): readonly string[] {
  if (text.length === 0) return [];
  // A later reference definition can change earlier links/footnotes.
  if (/^\s*\[[^\]]+\]:\s*\S+/mu.test(text)) return [text];
  // A partial new list marker may merge with the preceding list once completed.
  const stable =
    previous !== undefined && text.startsWith(previous.text) ? previous.blocks.slice(0, -2) : [];
  const stableLength = stable.reduce((length, block) => length + block.length, 0);
  const tail = text.slice(stableLength);
  const tree = markdownParser.parse(tail);
  if (tree.children.length === 0) return [...stable, tail];
  const starts = tree.children.map((node) => {
    const start = node.position!.start;
    // Retain indentation: it is syntax, particularly for indented code.
    return start.offset! - start.column + 1;
  });
  return [
    ...stable,
    ...starts.map((start, index) =>
      tail.slice(index === 0 ? 0 : start, starts[index + 1] ?? tail.length),
    ),
  ];
}

export function Markdown({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  const parsed = useRef<{ text: string; blocks: readonly string[] }>({ text: "", blocks: [] });
  const blocks = useMemo(() => {
    if (parsed.current.text === children && parsed.current.blocks.length > 0) {
      return parsed.current.blocks;
    }
    const blocks = streaming ? streamingMarkdownBlocks(children, parsed.current) : [children];
    parsed.current = { text: children, blocks };
    return blocks;
  }, [children, streaming]);
  return (
    <div className="product-markdown">
      {blocks.map((block, index) => (
        <StableMarkdownBody key={`markdown-block:${String(index)}`} t={t} text={block} />
      ))}
    </div>
  );
}
