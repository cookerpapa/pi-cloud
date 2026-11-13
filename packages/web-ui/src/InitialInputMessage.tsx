import type { PiCloudApi } from "./api.ts";
import type { TurnView } from "@pi-cloud/session-client";
import { useInputQueue, PendingInputEditor } from "./PendingInputQueue.tsx";
import { UploadCards } from "./UploadCards.tsx";
import { MessageCopyButton } from "./MessageCopyButton.tsx";
import { ComposerDelivery } from "./ComposerDelivery.tsx";
import { useI18n } from "./i18n.tsx";

export function InitialInputMessage({
  turn,
  api,
  onRetry,
  retryDisabled,
}: {
  turn: TurnView;
  api?: PiCloudApi;
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const { t } = useI18n();
  const queue = useInputQueue();
  const item =
    turn.status === "queued"
      ? queue?.queue?.items.find(
          (input) => input.inputId === turn.turnId && input.runMailboxPosition !== undefined,
        )
      : undefined;
  const editing = queue?.editing?.initial && queue.editing.inputId === turn.turnId;
  const menuOpen = queue?.menuInputId === turn.turnId;
  return (
    <div
      className="product-user-message-body initial-input-message"
      data-input-id={turn.turnId}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && menuOpen)
          queue?.setMenuInputId(null);
      }}
      onKeyDown={(event) => {
        if (!menuOpen || event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          queue?.setMenuInputId(null);
          event.currentTarget.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
        }
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]:not(:disabled)',
            ),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {turn.scheduledOrigin ? (
        <div
          className="product-scheduled-origin"
          data-scheduled-origin={turn.scheduledOrigin.scheduleId}
          title={new Date(turn.scheduledOrigin.scheduledAt).toLocaleString()}
        >
          {t("schedule.origin")} · {turn.scheduledOrigin.name}
        </div>
      ) : null}
      {editing ? (
        <PendingInputEditor started={turn.status !== "queued"} />
      ) : (
        <>
          <UploadCards
            {...(api ? { api } : {})}
            {...(turn.uploads ? { uploads: turn.uploads } : {})}
          />
          {turn.prompt ? <div className="product-user-bubble">{turn.prompt}</div> : null}
          {turn.localSubmission?.input.uploadIds.length ? (
            <small className="initial-input-attachments">
              {t("composer.sendingAttachments", {
                count: turn.localSubmission.input.uploadIds.length,
              })}
            </small>
          ) : null}
          {turn.localSubmission ? (
            <ComposerDelivery
              value={turn.localSubmission}
              statusOnly
              {...(onRetry ? { onRetry } : {})}
              {...(retryDisabled !== undefined ? { disabled: retryDisabled } : {})}
            />
          ) : null}
          <div className={`product-user-message-actions${item ? " initial-input-actions" : ""}`}>
            <MessageCopyButton
              copiedLabel={t("turn.copied")}
              label={t("turn.copyUserMessage")}
              text={turn.prompt ?? ""}
            />
            {item && queue ? (
              <button
                type="button"
                className="initial-input-more"
                aria-label={t("queue.actions")}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={!queue.canMutate || queue.busy !== null}
                onClick={() => queue.setMenuInputId(menuOpen ? null : turn.turnId)}
              >
                ⋯
              </button>
            ) : null}
          </div>
          {item && queue && menuOpen ? (
            <div className="pending-input-menu" role="menu" aria-label={t("queue.actions")}>
              <button
                type="button"
                role="menuitem"
                disabled={!queue.canMutate || queue.busy !== null}
                onClick={() => {
                  queue.setMenuInputId(null);
                  queue.setError(null);
                  queue.setEditing({
                    inputId: item.inputId,
                    text: item.text,
                    uploads: item.uploads ?? [],
                    initial: true,
                  });
                }}
              >
                {t("queue.edit")}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!queue.canMutate || queue.busy !== null}
                onClick={() => {
                  queue.setMenuInputId(null);
                  void queue.perform(item.inputId, { action: "cancel" });
                }}
              >
                {t("queue.withdraw")}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
