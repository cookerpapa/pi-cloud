import { useEffect, useState } from "react";

type SourceHighlightModule = typeof import("./source-highlight.ts");
type SourceHighlightResult = ReturnType<SourceHighlightModule["highlightSource"]>;

let loadedSourceHighlighter: SourceHighlightModule | null = null;
let sourceHighlighterPromise: Promise<SourceHighlightModule> | null = null;

function useSourceHighlighter(): SourceHighlightModule | null {
  const [ready, setReady] = useState(loadedSourceHighlighter !== null);
  useEffect(() => {
    if (ready) return;
    sourceHighlighterPromise ??= import("./source-highlight.ts");
    let active = true;
    void sourceHighlighterPromise.then((module) => {
      loadedSourceHighlighter = module;
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [ready]);
  return ready ? loadedSourceHighlighter : null;
}

export function HighlightedCode({
  text,
  path = null,
  language = null,
  className,
}: {
  text: string;
  path?: string | null;
  language?: string | null;
  className?: string;
}) {
  const highlighter = useSourceHighlighter();
  const highlighted: SourceHighlightResult =
    highlighter === null
      ? null
      : language === null
        ? highlighter.highlightSource(text, path)
        : highlighter.highlightLanguage(text, language);
  return (
    <code
      className={
        highlighted === null
          ? className
          : [className, "hljs", `language-${highlighted.language}`].filter(Boolean).join(" ")
      }
    >
      {highlighted === null ? (
        text
      ) : (
        <span
          // Highlight.js escapes source text before adding token spans.
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      )}
    </code>
  );
}
