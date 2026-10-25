import { useState } from "react";
import type { ConversationUsageResource, ConversationCompactResource } from "@pi-cloud/protocol";
import { useI18n } from "./i18n.tsx";

const labels = {
  queued: "compact.queued",
  summarizing: "compact.summarizing",
  awaiting_placement: "compact.awaiting",
  applied: "compact.applied",
  no_op: "compact.noOp",
  stale: "compact.stale",
  cancelled: "compact.cancelled",
  failed: "compact.failed",
} as const;
export function CompactStatus({
  state,
  instructions,
}: {
  state: ConversationCompactResource["state"];
  instructions?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={`product-compact-status ${state}`} role="status">
      <code title={instructions}>/compact{instructions ? ` ${instructions}` : ""}</code>
      <span>{t(labels[state])}</span>
    </div>
  );
}
export function ConversationUsage({
  value,
  loading,
  error,
  onRefresh,
  onClose,
}: {
  value: ConversationUsageResource | null;
  loading: boolean;
  error: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const [children, setChildren] = useState(false);
  const count = (value: number | null) =>
    value === null ? "—" : new Intl.NumberFormat(language).format(value);
  const tokens = children && value ? value.includingChildren : value?.tokens;
  return (
    <section className="product-usage-panel" role="dialog" aria-label={t("usage.title")}>
      <header>
        <strong>/usage</strong>
        <span>{value?.model.modelId}</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label={t("usage.refresh")}
        >
          ↻
        </button>
        <button type="button" onClick={onClose} aria-label={t("usage.close")}>
          ×
        </button>
      </header>
      {error ? <p role="alert">{t("usage.failed")}</p> : null}
      {loading && !value ? <p role="status">{t("usage.loading")}</p> : null}
      {value && tokens ? (
        <>
          <dl className="product-usage-grid">
            <div>
              <dt>{t("usage.input")}</dt>
              <dd>{count(tokens.input)}</dd>
            </div>
            <div>
              <dt>{t("usage.output")}</dt>
              <dd>{count(tokens.output)}</dd>
            </div>
            <div>
              <dt>{t("usage.cacheRead")}</dt>
              <dd>{count(tokens.cacheRead)}</dd>
            </div>
            {tokens.cacheWrite > 0 ? (
              <div>
                <dt>{t("usage.cacheWrite")}</dt>
                <dd>{count(tokens.cacheWrite)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t("usage.total")}</dt>
              <dd>{count(tokens.total)}</dd>
            </div>
          </dl>
          {value.children.length ? (
            <label className="product-usage-child-toggle">
              <input
                type="checkbox"
                checked={children}
                onChange={(e) => setChildren(e.target.checked)}
              />
              {t("usage.includeChildren")}
            </label>
          ) : null}
          <div className="product-usage-context">
            <span>{t("usage.context")}</span>
            <strong>
              ≈ {count(value.context.estimatedTokens)} / {count(value.context.window)}
            </strong>
            {value.context.window && value.context.estimatedTokens !== null ? (
              <progress
                max={value.context.window}
                value={Math.min(value.context.estimatedTokens, value.context.window)}
                aria-label={t("usage.context")}
              />
            ) : null}
            <small>
              {t("usage.threshold")} {count(value.context.compactThreshold)}
            </small>
          </div>
          <details>
            <summary>{t("usage.breakdown")}</summary>
            {value.models.map((model) => (
              <div className="product-usage-breakdown" key={`${model.provider}/${model.modelId}`}>
                <span>{model.modelId}</span>
                <span>{count(model.tokens.total)}</span>
              </div>
            ))}
            {value.children.map((child) => (
              <div className="product-usage-breakdown" key={child.sessionId}>
                <span>{child.title}</span>
                <span>{count(child.tokens.total)}</span>
              </div>
            ))}
          </details>
          <small>{t("usage.recorded")}</small>
        </>
      ) : null}
    </section>
  );
}
