import { useInputQueue } from "./PendingInputQueue.tsx";
import { authoritativeInputAppeared } from "./submission-presentation.ts";
import type { TurnView } from "./session-view.ts";
import type { ComposerSubmissionView } from "./composer-submission.ts";
import { useI18n } from "./i18n.tsx";

/** Local delivery feedback. It never creates a Run or a canonical user row. */
export function ComposerDelivery({
  value,
  statusOnly = false,
  onRetry,
  disabled = false,
  turns,
}: {
  value: ComposerSubmissionView | null;
  statusOnly?: boolean;
  onRetry?: () => void;
  disabled?: boolean;
  turns?: readonly TurnView[];
}) {
  const { t } = useI18n();
  const queue = useInputQueue();
  if (!value || value.input.kind !== "turn") return null;
  if (turns) {
    const discovered = authoritativeInputAppeared(value, turns, queue?.queue);
    if (value.placement === "timeline" && !discovered) return null;
    statusOnly ||= discovered;
  }
  return (
    <div className={`composer-delivery ${value.state}`} role="status" aria-live="polite">
      <span className="composer-delivery-state">
        {t(value.state === "sending" ? "composer.sending" : "composer.unconfirmed")}
      </span>
      {value.state === "unconfirmed" && onRetry ? (
        <button type="button" disabled={disabled} onClick={onRetry}>
          {t("composer.retry")}
        </button>
      ) : null}
      {!statusOnly && value.input.text ? <p>{value.input.text}</p> : null}
      {!statusOnly && value.input.uploadIds.length ? (
        <small>{t("composer.sendingAttachments", { count: value.input.uploadIds.length })}</small>
      ) : null}
    </div>
  );
}
