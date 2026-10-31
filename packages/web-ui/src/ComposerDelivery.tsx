import type { ComposerSubmissionView } from "./composer-submission.ts";
import { useI18n } from "./i18n.tsx";

/** Local delivery feedback. It never creates a Run or a canonical user row. */
export function ComposerDelivery({ value }: { value: ComposerSubmissionView | null }) {
  const { t } = useI18n();
  if (!value || value.input.kind !== "turn") return null;
  return (
    <div className={`composer-delivery ${value.state}`} role="status" aria-live="polite">
      <span className="composer-delivery-state">
        {t(value.state === "sending" ? "composer.sending" : "composer.unconfirmed")}
      </span>
      {value.input.text ? <p>{value.input.text}</p> : null}
      {value.input.uploadIds.length ? (
        <small>{t("composer.sendingAttachments", { count: value.input.uploadIds.length })}</small>
      ) : null}
    </div>
  );
}
