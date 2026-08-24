import { useState, type ReactNode } from "react";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { useI18n, type Translate } from "./i18n.tsx";
import type { TranscriptItem } from "./session-view.ts";

export type ToolTranscriptItem = Extract<TranscriptItem, { kind: "tool" }>;

type JsonRecord = Record<string, unknown>;

type ToolRenderContext = {
  item: ToolTranscriptItem;
  input: JsonRecord | null;
  output: string;
  command: string | null;
  path: string | null;
  content: string | null;
};

type ToolRenderer = {
  heading(context: ToolRenderContext, t: Translate): ReactNode;
  body(context: ToolRenderContext, t: Translate): ReactNode;
};

function safeDisplay(value: unknown, t?: Translate): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (rendered === undefined) return "";
  return rendered.length > 12_000
    ? `${rendered.slice(0, 12_000)}\n${t?.("turn.outputTruncated") ?? "…输出已截断"}`
    : rendered;
}

function objectValue(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
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
  const normalized = text.replace(/\n+$/u, "");
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
  return (
    <div className="product-tool-text">
      {omitted > 0 && !expanded && direction === "tail" ? (
        <button type="button" onClick={() => setExpanded(true)}>
          {t("turn.earlierLines", { count: omitted })}
        </button>
      ) : null}
      <pre className={className}>
        <HighlightedCode
          path={sourcePath}
          suffix={
            streaming ? <span aria-hidden="true" className="product-tool-stream-cursor" /> : null
          }
          text={visible}
        />
      </pre>
      {omitted > 0 && !expanded && direction === "head" ? (
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

function pathHeading(name: string, path: string | null): ReactNode {
  return (
    <div className="product-tool-operation">
      <strong>{name}</strong>
      {path === null ? null : <code>{path}</code>}
    </div>
  );
}

const bashRenderer: ToolRenderer = {
  heading(context, t) {
    if (context.command === null) return pathHeading("bash", null);
    if (context.command.includes("\n")) {
      return (
        <div className="product-tool-operation product-tool-multiline-label">
          <strong>bash</strong>
          <span>{t("turn.commandLines", { count: context.command.split("\n").length })}</span>
        </div>
      );
    }
    return (
      <div className="product-tool-command">
        <span aria-hidden="true">$</span>
        <code>{context.command}</code>
      </div>
    );
  },
  body(context) {
    const displayedCommand =
      context.command === null
        ? null
        : context.command
            .split("\n")
            .map((line, index) => `${index === 0 ? "$ " : "  "}${line}`)
            .join("\n");
    return (
      <>
        {context.command?.includes("\n") && displayedCommand !== null ? (
          <ExpandableToolText
            className="product-tool-command-block"
            direction="head"
            text={displayedCommand}
          />
        ) : null}
        {context.output.length > 0 ? (
          <ExpandableToolText
            className="product-tool-terminal"
            direction="tail"
            text={context.output}
          />
        ) : null}
      </>
    );
  },
};

const readRenderer: ToolRenderer = {
  heading(context) {
    const offset = context.input?.offset;
    const limit = context.input?.limit;
    return (
      <div className="product-tool-operation">
        <strong>read</strong>
        {context.path === null ? null : <code>{context.path}</code>}
        {typeof offset === "number" || typeof limit === "number" ? (
          <span className="product-tool-operation-note">
            {typeof offset === "number" ? `L${String(offset)}` : ""}
            {typeof limit === "number" ? ` +${String(limit)}` : ""}
          </span>
        ) : null}
      </div>
    );
  },
  body(context) {
    return context.output.length === 0 ? null : (
      <ExpandableToolText
        className="product-tool-source"
        direction="head"
        sourcePath={context.path}
        text={context.output}
      />
    );
  },
};

const writeRenderer: ToolRenderer = {
  heading(context) {
    return pathHeading("write", context.path);
  },
  body(context) {
    const conventionalResult = /^Successfully wrote \d+ bytes to /u.test(context.output.trim());
    return (
      <>
        {context.content === null ? null : (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            sourcePath={context.path}
            text={context.content}
          />
        )}
        {context.output.length > 0 && !conventionalResult ? (
          <ExpandableToolText
            className="product-tool-output"
            direction="head"
            text={context.output}
          />
        ) : null}
      </>
    );
  },
};

function editValues(input: JsonRecord | null): readonly { oldText: string; newText: string }[] {
  if (!Array.isArray(input?.edits)) return [];
  return input.edits.flatMap((value) => {
    const edit = objectValue(value);
    const oldText = stringValue(edit?.oldText);
    const newText = stringValue(edit?.newText);
    return oldText === null || newText === null ? [] : [{ oldText, newText }];
  });
}

function DiffLines({ prefix, text }: { prefix: "+" | "-"; text: string }) {
  return (
    <>
      {text.split("\n").map((line, index) => (
        <div className={prefix === "+" ? "product-diff-added" : "product-diff-removed"} key={index}>
          <span aria-hidden="true">{prefix}</span>
          <code>{line.length === 0 ? " " : line}</code>
        </div>
      ))}
    </>
  );
}

const editRenderer: ToolRenderer = {
  heading(context) {
    return pathHeading("edit", context.path);
  },
  body(context, t) {
    const edits = editValues(context.input);
    const conventionalResult = /^(Successfully (?:replaced|edited)|Applied \d+ edit)/iu.test(
      context.output.trim(),
    );
    return (
      <>
        {edits.length === 0 ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            text={safeDisplay(context.item.input, t)}
          />
        ) : (
          <div className="product-tool-diff" role="group">
            {edits.map((edit, index) => (
              <div className="product-tool-diff-hunk" key={index}>
                {edits.length > 1 ? (
                  <div className="product-tool-diff-label">
                    {t("turn.editNumber", { count: index + 1 })}
                  </div>
                ) : null}
                <DiffLines prefix="-" text={edit.oldText} />
                <DiffLines prefix="+" text={edit.newText} />
              </div>
            ))}
          </div>
        )}
        {context.output.length > 0 && !conventionalResult ? (
          <ExpandableToolText
            className="product-tool-output"
            direction="head"
            text={context.output}
          />
        ) : null}
      </>
    );
  },
};

const defaultRenderer: ToolRenderer = {
  heading(context) {
    return pathHeading(context.item.toolName, context.path);
  },
  body(context, t) {
    return (
      <>
        {context.path === null ? (
          <ExpandableToolText
            className="product-tool-source"
            direction="head"
            text={safeDisplay(context.item.input, t)}
          />
        ) : null}
        {context.output.length > 0 ? (
          <ExpandableToolText
            className="product-tool-output"
            direction="head"
            text={context.output}
          />
        ) : null}
      </>
    );
  },
};

const TOOL_RENDERERS: Readonly<Record<string, ToolRenderer>> = {
  bash: bashRenderer,
  edit: editRenderer,
  read: readRenderer,
  write: writeRenderer,
};

function renderContext(item: ToolTranscriptItem, t: Translate): ToolRenderContext {
  const input = objectValue(item.input);
  return {
    item,
    input,
    output: item.output === undefined ? "" : toolOutputText(item.output, t),
    command: stringValue(input?.command),
    path: stringValue(input?.path),
    content: stringValue(input?.content),
  };
}

export function compactToolSummary(item: ToolTranscriptItem): string {
  const input = objectValue(item.input);
  const path = stringValue(input?.path);
  const command = stringValue(input?.command);
  if (item.toolName === "bash" && command !== null) return command.split("\n")[0]!.slice(0, 100);
  if (path !== null) return path;
  return item.toolName;
}

export function ToolActivity({ item }: { item: ToolTranscriptItem }) {
  const { t } = useI18n();
  const context = renderContext(item, t);
  const renderer = TOOL_RENDERERS[item.toolName] ?? defaultRenderer;
  const duration = durationLabel(item.startedAt, item.completedAt);
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
  return (
    <section
      aria-label={`${item.toolName} ${statusLabel}`}
      className={`product-tool product-tool-${item.status}`}
      data-tool-name={item.toolName}
    >
      <div className="product-tool-line">
        <span className="product-tool-icon" aria-hidden="true">
          {icon}
        </span>
        {renderer.heading(context, t)}
        <span className="product-tool-state">{statusLabel}</span>
      </div>
      <div className="product-tool-body">
        {renderer.body(context, t)}
        {duration === null ? null : (
          <div className="product-tool-duration">{t("turn.took", { duration })}</div>
        )}
      </div>
    </section>
  );
}
