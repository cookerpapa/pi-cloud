import { useEffect, useMemo, useRef, useState } from "react";
import { deriveConversationPresentationRows } from "./conversation-presentation.ts";
import { Markdown } from "./Markdown.tsx";
import type { TranscriptItem, TurnView } from "./session-view.ts";
import { compactToolSummary, ToolActivity, type ToolTranscriptItem } from "./ToolActivity.tsx";
import { useI18n } from "./i18n.tsx";
import { MessageCopyButton } from "./MessageCopyButton.tsx";

const MAXIMUM_PROGRESSIVE_CHARACTERS_PER_FRAME = 32;
const PROGRESSIVE_BOUNDARY_LOOKAHEAD = 4;

function progressiveCharacterStep(remaining: number): number {
  if (remaining > 1_024) return 32;
  if (remaining > 512) return 20;
  if (remaining > 128) return 12;
  if (remaining > 32) return 8;
  return 4;
}

export function nextProgressiveTextIndex(text: string, currentIndex: number): number {
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex > text.length) {
    throw new TypeError("Progressive text index is invalid");
  }
  const remaining = text.length - currentIndex;
  if (remaining <= 0) return text.length;
  const step = Math.min(
    MAXIMUM_PROGRESSIVE_CHARACTERS_PER_FRAME,
    progressiveCharacterStep(remaining),
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
    .slice(next, Math.min(text.length, next + PROGRESSIVE_BOUNDARY_LOOKAHEAD))
    .search(/[\s，。！？；：、,.!?;:)]/u);
  return nearbyBoundary < 0 ? next : Math.min(text.length, next + nearbyBoundary + 1);
}

export function initialProgressiveText(
  text: string,
  streaming: boolean,
  recoveredTextLength = 0,
): string {
  if (!Number.isSafeInteger(recoveredTextLength) || recoveredTextLength < 0) {
    throw new TypeError("Recovered text length is invalid");
  }
  return streaming ? text.slice(0, Math.min(text.length, recoveredTextLength)) : text;
}

function useProgressiveText(
  text: string,
  streaming: boolean,
  onProgress: (() => void) | undefined,
  recoveredTextLength = 0,
): string {
  const animated = useRef(streaming);
  const callback = useRef(onProgress);
  const frameRef = useRef<number | null>(null);
  const targetRef = useRef(text);
  const visibleRef = useRef(initialProgressiveText(text, streaming, recoveredTextLength));
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
  const visibleText = useProgressiveText(
    item.text,
    streaming,
    onPresentationProgress,
    item.recoveredTextLength,
  );
  return (
    <div className={processNarration ? "product-agent-stage" : "product-agent-answer"}>
      <Markdown sessionId={sessionId}>{visibleText}</Markdown>
    </div>
  );
}

function activitySummary(items: readonly ToolTranscriptItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => (count > 1 ? `${name} ×${String(count)}` : name))
    .join(" · ");
}

function ToolActivityGroup({ items }: { items: readonly ToolTranscriptItem[] }) {
  const { t } = useI18n();
  const running = items.some((item) => item.status === "running");
  const issue = items.some((item) => item.status === "failed" || item.status === "unknown");
  const [expanded, setExpanded] = useState(running || issue);
  useEffect(() => {
    if (running || issue) setExpanded(true);
  }, [issue, running]);
  if (items.length === 1) return <ToolActivity item={items[0]!} />;
  const current =
    items.reduce<ToolTranscriptItem | undefined>(
      (candidate, item) => (item.status === "running" ? item : candidate),
      undefined,
    ) ?? items.at(-1)!;
  const summary = running ? compactToolSummary(current) : activitySummary(items);
  return (
    <section
      className={`product-activity-group ${issue ? "has-issue" : ""}`}
      data-expanded={expanded}
    >
      <button
        aria-expanded={expanded}
        className="product-activity-group-toggle"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span
          aria-hidden="true"
          className={`product-activity-chevron ${expanded ? "expanded" : ""}`}
        >
          ›
        </span>
        <span
          aria-hidden="true"
          className={`product-activity-status ${running ? "running" : issue ? "issue" : ""}`}
        >
          {running ? "◌" : issue ? "!" : "✓"}
        </span>
        <strong>{t("turn.activitySteps", { count: items.length })}</strong>
        <span title={summary}>{summary}</span>
      </button>
      {expanded ? (
        <div className="product-activity-group-items">
          {items.map((item) => (
            <ToolActivity item={item} key={item.key} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LifecycleItem({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "compaction" } | { kind: "retry" }>;
}) {
  const { t } = useI18n();
  if (item.kind === "retry") {
    const delay =
      item.delayMs === undefined
        ? null
        : item.delayMs < 1_000
          ? `${String(item.delayMs)}ms`
          : `${(item.delayMs / 1_000).toFixed(1)}s`;
    return (
      <div className="product-lifecycle product-lifecycle-retry">
        <span aria-hidden="true">↻</span>
        {delay === null || item.maximumSamplingAttempts === undefined
          ? t("turn.retryAttempt", { attempt: item.nextSamplingAttempt })
          : t("turn.retryScheduled", {
              attempt: item.nextSamplingAttempt,
              maximum: item.maximumSamplingAttempts,
              delay,
            })}
      </div>
    );
  }
  const label =
    item.status === "running"
      ? t("turn.compactionRunning")
      : item.status === "completed"
        ? t("turn.compactionCompleted")
        : item.status === "aborted"
          ? t("turn.compactionAborted")
          : t("turn.compactionFailed");
  const tokenChange =
    item.tokensBefore === undefined || item.estimatedTokensAfter === undefined
      ? null
      : `${item.tokensBefore.toLocaleString()} → ${item.estimatedTokensAfter.toLocaleString()} tokens`;
  return (
    <div className={`product-lifecycle product-lifecycle-${item.status}`}>
      <span aria-hidden="true">
        {item.status === "running" ? "◌" : item.status === "completed" ? "✓" : "!"}
      </span>
      <span>{label}</span>
      {tokenChange === null ? null : <code>{tokenChange}</code>}
      {item.willRetry ? <small>{t("turn.compactionResuming")}</small> : null}
    </div>
  );
}

function OtherItem({
  item,
}: {
  item: Exclude<TranscriptItem, { kind: "text" } | { kind: "tool" }>;
}) {
  if (item.kind === "compaction" || item.kind === "retry") return <LifecycleItem item={item} />;
  if (item.kind === "notification") {
    return (
      <div className={`product-notification product-notification-${item.level}`}>
        {item.message}
      </div>
    );
  }
  return null;
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
  const rows = useMemo(() => deriveConversationPresentationRows(turn.items), [turn.items]);
  const finalAnswerText = useMemo(
    () =>
      rows
        .filter((row) => row.kind === "text" && !row.processNarration)
        .map((row) => (row.kind === "text" ? row.item.text : ""))
        .join("\n\n"),
    [rows],
  );
  return (
    <section
      className="product-turn"
      data-conversation-turn-id={turn.turnId}
      id={`turn-${turn.turnId}`}
    >
      <div className="product-message product-user-message">
        <div className="product-user-message-body">
          <div className="product-user-bubble">{turn.prompt}</div>
          <div className="product-user-message-actions">
            <MessageCopyButton
              copiedLabel={t("turn.copied")}
              label={t("turn.copyUserMessage")}
              text={turn.prompt}
            />
          </div>
        </div>
      </div>
      <div className="product-message product-assistant-message">
        <div className="product-assistant-content">
          {rows.length === 0 && working ? (
            <div className="product-thinking">
              <i />
              <i />
              <i />
              <span>{t("turn.thinking")}</span>
            </div>
          ) : (
            rows.map((row) => {
              if (row.kind === "text") {
                return (
                  <AssistantTextItem
                    item={row.item}
                    key={row.key}
                    onPresentationProgress={onPresentationProgress}
                    processNarration={row.processNarration}
                    sessionId={sessionId}
                    streaming={working}
                  />
                );
              }
              if (row.kind === "activity") {
                return <ToolActivityGroup items={row.items} key={row.key} />;
              }
              return <OtherItem item={row.item} key={row.key} />;
            })
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
          {turn.status === "completed" && (finalAnswerText.length > 0 || onFork || onPrune) ? (
            <div className="product-answer-actions">
              {finalAnswerText.length > 0 ? (
                <MessageCopyButton
                  copiedLabel={t("turn.copied")}
                  label={t("turn.copyAssistantMessage")}
                  text={finalAnswerText}
                />
              ) : null}
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
