import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptItem, TurnView } from "./session-view.ts";
import { useI18n, type Translate } from "./i18n.tsx";

type SourceHighlightModule = typeof import("./source-highlight.ts");
type SourceHighlightResult = ReturnType<SourceHighlightModule["highlightSource"]>;

let loadedSourceHighlighter: SourceHighlightModule | null = null;
let sourceHighlighterPromise: Promise<SourceHighlightModule> | null = null;

const MAXIMUM_PROGRESSIVE_CHARACTERS_PER_FRAME = 1_024;

export function nextProgressiveTextIndex(text: string, currentIndex: number): number {
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex > text.length) {
    throw new TypeError("Progressive text index is invalid");
  }
  const remaining = text.length - currentIndex;
  if (remaining <= 0) return text.length;
  const step = Math.min(
    MAXIMUM_PROGRESSIVE_CHARACTERS_PER_FRAME,
    Math.max(2, Math.ceil(remaining / 5)),
  );
  let next = Math.min(text.length, currentIndex + step);
  const previousCodeUnit = text.charCodeAt(next - 1);
  const nextCodeUnit = text.charCodeAt(next);
  if (
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    next += 1;
  }
  const nearbyBoundary = text
    .slice(next, Math.min(text.length, next + 12))
    .search(/[\s，。！？；：、,.!?;:)]/u);
  return nearbyBoundary < 0 ? next : Math.min(text.length, next + nearbyBoundary + 1);
}

function useProgressiveText(
  text: string,
  streaming: boolean,
  onProgress: (() => void) | undefined,
): string {
  const animated = useRef(streaming);
  const callback = useRef(onProgress);
  const frameRef = useRef<number | null>(null);
  const targetRef = useRef(text);
  const visibleRef = useRef(streaming ? "" : text);
  const [visible, setVisible] = useState(visibleRef.current);

  useEffect(() => {
    callback.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    targetRef.current = text;
    if (streaming) animated.current = true;
    const current = visibleRef.current;
    const reduceMotion =
      document.visibilityState === "hidden" ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!animated.current || reduceMotion || !text.startsWith(current)) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      visibleRef.current = text;
      setVisible(text);
      return;
    }
    if (current.length >= text.length || frameRef.current !== null) return;
    const advance = (): void => {
      const target = targetRef.current;
      const nextIndex = nextProgressiveTextIndex(target, visibleRef.current.length);
      const next = target.slice(0, nextIndex);
      visibleRef.current = next;
      setVisible(next);
      frameRef.current = nextIndex < target.length ? requestAnimationFrame(advance) : null;
    };
    frameRef.current = requestAnimationFrame(advance);
  }, [streaming, text]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (visible.length === 0) return;
    const frame = requestAnimationFrame(() => callback.current?.());
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return visible;
}

function useSourceHighlight(text: string, path: string | null): SourceHighlightResult {
  const [ready, setReady] = useState(loadedSourceHighlighter !== null);
  useEffect(() => {
    if (path === null || ready) return;
    sourceHighlighterPromise ??= import("./source-highlight.ts");
    let active = true;
    void sourceHighlighterPromise.then((module) => {
      loadedSourceHighlighter = module;
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, [path, ready]);
  return ready && loadedSourceHighlighter !== null
    ? loadedSourceHighlighter.highlightSource(text, path)
    : null;
}

function safeDisplay(value: unknown, t?: Translate): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (rendered === undefined) return "";
  return rendered.length > 12_000
    ? `${rendered.slice(0, 12_000)}\n${t?.("turn.outputTruncated") ?? "…输出已截断"}`
    : rendered;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toolOutputText(value: unknown, t: Translate): string {
  if (typeof value === "string") return value;
  const output = objectValue(value);
  if (output === null || !Array.isArray(output.content)) return safeDisplay(value, t);
  const content = output.content
    .map((part) => {
      const candidate = objectValue(part);
      return candidate?.type === "text" ? stringValue(candidate.text) : null;
    })
    .filter((part): part is string => part !== null)
    .join("\n");
  return content.length > 0 ? content : safeDisplay(value, t);
}

function durationLabel(startedAt: string, completedAt: string | undefined): string | null {
  if (completedAt === undefined) return null;
  const milliseconds = new Date(completedAt).valueOf() - new Date(startedAt).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  return `${String(minutes)}m ${((milliseconds % 60_000) / 1_000).toFixed(1)}s`;
}

function ExpandableToolText({
  text,
  direction,
  className,
  sourcePath = null,
  streaming = false,
}: {
  text: string;
  direction: "head" | "tail";
  className: string;
  sourcePath?: string | null;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const normalized = text.replace(/\n+$/, "");
  const lines = normalized.split("\n");
  const maximumLines = direction === "head" ? 16 : 20;
  const omitted = Math.max(0, lines.length - maximumLines);
  const preview =
    omitted === 0
      ? normalized
      : direction === "head"
        ? lines.slice(0, maximumLines).join("\n")
        : lines.slice(-maximumLines).join("\n");
  const visible = expanded ? normalized : preview;
  const highlighted = useSourceHighlight(visible, sourcePath);
  return (
    <div className="product-tool-text">
      {omitted > 0 && !expanded && direction === "tail" ? (
        <button type="button" onClick={() => setExpanded(true)}>
          {t("turn.earlierLines", { count: omitted })}
        </button>
      ) : null}
      <pre className={className}>
        {highlighted === null ? (
          <code>{visible}</code>
        ) : (
          <code
            className={`hljs language-${highlighted.language}`}
            dangerouslySetInnerHTML={{ __html: highlighted.html }}
          />
        )}
        {streaming ? <span aria-hidden="true" className="product-tool-stream-cursor" /> : null}
      </pre>
      {omitted > 0 && direction === "head" && !expanded ? (
        <button type="button" onClick={() => setExpanded(true)}>
          {t("turn.moreLines", { count: omitted })}
        </button>
      ) : null}
      {omitted > 0 && expanded ? (
        <button type="button" onClick={() => setExpanded(false)}>
          {t("turn.collapse")}
        </button>
      ) : null}
    </div>
  );
}

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
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: label, href }) => (
            <a
              href={conversationPreviewHref(href, sessionId)}
              rel="noreferrer noopener"
              target="_blank"
            >
              {label}
            </a>
          ),
          img: ({ alt }) => (
            <span className="product-image-placeholder">{t("turn.image", { alt: alt ?? "" })}</span>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function ToolActivity({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const { t } = useI18n();
  const input = objectValue(item.input);
  const command = stringValue(input?.command);
  const path = stringValue(input?.path);
  const content = stringValue(input?.content);
  const output = item.output === undefined ? "" : toolOutputText(item.output, t);
  const multilineCommand = command !== null && command.includes("\n");
  const displayedCommand =
    command === null
      ? null
      : command
          .split("\n")
          .map((line, index) => `${index === 0 ? "$ " : "  "}${line}`)
          .join("\n");
  const duration = durationLabel(item.startedAt, item.completedAt);
  const conventionalWriteResult = /^Successfully wrote \d+ bytes to /u.test(output.trim());
  const statusLabel =
    item.status === "running"
      ? t("turn.executing")
      : item.status === "unknown"
        ? t("turn.unknown")
        : item.status === "failed"
          ? t("turn.failed")
          : t("turn.completed");
  const icon =
    item.status === "running"
      ? "◌"
      : item.status === "unknown"
        ? "?"
        : item.status === "failed"
          ? "!"
          : "✓";
  const heading =
    item.toolName === "bash" && command !== null && !multilineCommand ? (
      <div className="product-tool-command">
        <span aria-hidden="true">$</span>
        <code>{command}</code>
      </div>
    ) : item.toolName === "bash" && multilineCommand ? (
      <div className="product-tool-operation product-tool-multiline-label">
        <strong>bash</strong>
        <span>{t("turn.commandLines", { count: command.split("\n").length })}</span>
      </div>
    ) : (
      <div className="product-tool-operation">
        <strong>{item.toolName}</strong>
        {path === null ? null : <code>{path}</code>}
      </div>
    );
  return (
    <section
      aria-label={`${item.toolName} ${statusLabel}`}
      className={`product-tool product-tool-${item.status}`}
    >
      <div className="product-tool-line">
        <span className="product-tool-icon" aria-hidden="true">
          {icon}
        </span>
        {heading}
        <span className="product-tool-state">{statusLabel}</span>
      </div>
      <div className="product-tool-body">
        {item.toolName === "bash" && multilineCommand && displayedCommand !== null ? (
          <ExpandableToolText
            className="product-tool-command-block"
            direction="head"
            text={displayedCommand}
          />
        ) : item.toolName === "write" && content !== null ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            sourcePath={path}
            streaming={false}
            text={content}
          />
        ) : item.toolName !== "bash" && path === null ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            text={safeDisplay(item.input, t)}
          />
        ) : null}
        {output.length > 0 && !(item.toolName === "write" && conventionalWriteResult) ? (
          <ExpandableToolText
            className={item.toolName === "bash" ? "product-tool-terminal" : "product-tool-output"}
            direction={item.toolName === "bash" ? "tail" : "head"}
            text={output}
          />
        ) : null}
        {duration === null ? null : (
          <div className="product-tool-duration">{t("turn.took", { duration })}</div>
        )}
      </div>
    </section>
  );
}

function AssistantItem({
  item,
  sessionId,
  onPresentationProgress,
  processNarration,
  streaming,
}: {
  item: TranscriptItem;
  sessionId: string | undefined;
  onPresentationProgress: (() => void) | undefined;
  processNarration: boolean;
  streaming: boolean;
}) {
  const { t } = useI18n();
  if (item.kind === "text") {
    return (
      <AssistantTextItem
        item={item}
        sessionId={sessionId}
        onPresentationProgress={onPresentationProgress}
        processNarration={processNarration}
        streaming={streaming}
      />
    );
  }
  if (item.kind === "tool") return <ToolActivity item={item} />;
  if (item.kind === "notification") {
    return (
      <div className={`product-notification product-notification-${item.level}`}>
        {item.message}
      </div>
    );
  }
  return (
    <div className="product-notification">
      {item.outcome === undefined
        ? t("turn.awaitingApproval", { title: item.approval.title })
        : t("turn.approvalHandled", { title: item.approval.title })}
    </div>
  );
}

function AssistantTextItem({
  item,
  sessionId,
  onPresentationProgress,
  processNarration,
  streaming,
}: {
  item: Extract<TranscriptItem, { kind: "text" }>;
  sessionId: string | undefined;
  onPresentationProgress: (() => void) | undefined;
  processNarration: boolean;
  streaming: boolean;
}) {
  const visibleText = useProgressiveText(item.text, streaming, onPresentationProgress);
  return (
    <div className={processNarration ? "product-agent-stage" : "product-agent-answer"}>
      <Markdown sessionId={sessionId}>{visibleText}</Markdown>
    </div>
  );
}

export function ConversationTurn({
  turn,
  sessionId,
  canFork = false,
  onFork,
  canPrune = false,
  onPrune,
  onPresentationProgress,
}: {
  turn: TurnView;
  sessionId?: string | undefined;
  canFork?: boolean;
  onFork?: () => void;
  canPrune?: boolean;
  onPrune?: () => void;
  onPresentationProgress?: () => void;
}) {
  const { t } = useI18n();
  const working =
    turn.status === "queued" || turn.status === "running" || turn.status === "cancelling";
  const lastToolIndex = turn.items.reduce(
    (lastIndex, item, index) => (item.kind === "tool" ? index : lastIndex),
    -1,
  );
  return (
    <section
      className="product-turn"
      data-conversation-turn-id={turn.turnId}
      id={`turn-${turn.turnId}`}
    >
      <div className="product-message product-user-message">
        <div className="product-user-bubble">{turn.prompt}</div>
      </div>
      <div className="product-message product-assistant-message">
        <div className="product-avatar" aria-hidden="true">
          A
        </div>
        <div className="product-assistant-content">
          {turn.items.length === 0 && working ? (
            <div className="product-thinking">
              <i />
              <i />
              <i />
              <span>{t("turn.thinking")}</span>
            </div>
          ) : (
            turn.items.map((item, index) => (
              <AssistantItem
                item={item}
                key={item.key}
                onPresentationProgress={onPresentationProgress}
                processNarration={item.kind === "text" && index < lastToolIndex}
                sessionId={sessionId}
                streaming={working && item.kind === "text"}
              />
            ))
          )}
          {turn.failure ? (
            <div className="product-turn-error">
              <strong>{t("turn.runFailed")}</strong>
              <span>
                {turn.failure.code === "run_timed_out"
                  ? t("error.runTimedOut")
                  : turn.failure.message === "这次运行失败了，请重试。"
                    ? t("error.runFailed")
                    : turn.failure.message}
              </span>
            </div>
          ) : null}
          {turn.cancellation ? <div className="product-muted-line">{t("turn.stopped")}</div> : null}
          {turn.status === "completed" && (onFork || onPrune) ? (
            <div className="product-answer-actions">
              {onFork ? (
                <button disabled={!canFork} onClick={onFork} type="button">
                  <span aria-hidden="true">↳</span>
                  {t("turn.fork")}
                </button>
              ) : null}
              {onPrune ? (
                <button
                  className="product-prune-action"
                  disabled={!canPrune}
                  onClick={onPrune}
                  type="button"
                >
                  <span aria-hidden="true">⌫</span>
                  {t("turn.prune")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
