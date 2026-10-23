import { restoreReturnedInputs, type InputReturnRecovery } from "./returned-inputs.ts";
import { UploadCards } from "./UploadCards.tsx";
import type { UserUpload } from "@pi-cloud/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { InputQueueResource, QueuedInputAction } from "@pi-cloud/protocol";
import { PiCloudApi, PiCloudApiError, newIdempotencyKey } from "./api.ts";
import { useI18n } from "./i18n.tsx";

type Action =
  | { action: "edit"; text: string }
  | { action: "cancel" }
  | { action: "move"; direction: "up" | "down" }
  | { action: "steer"; text?: string };

export function PendingInputQueue({
  api,
  sessionId,
  canMutate,
  refreshSignal,
  streamQueue,
  onSnapshot,
  onRestoreDraft,
  returnRecovery,
}: {
  api: PiCloudApi;
  sessionId: string;
  canMutate: boolean;
  refreshSignal: string;
  streamQueue: InputQueueResource | null;
  onSnapshot: (queue: InputQueueResource) => void;
  returnRecovery: InputReturnRecovery;
  onRestoreDraft: (
    text: string,
    uploads: UserUpload[],
    returnedKeys?: readonly string[],
  ) => boolean | void;
}) {
  const { t } = useI18n();
  const [queue, setQueue] = useState<InputQueueResource | null>(null);
  const current = useRef<InputQueueResource | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const listId = useId();
  const root = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [menuInputId, setMenuInputId] = useState<string | null>(null);
  const readAbort = useRef<AbortController | undefined>(undefined);
  const [error, setError] = useState<
    "queue.loadError" | "queue.actionError" | "queue.changed" | "queue.noActive" | null
  >(null);
  const [editing, setEditing] = useState<{
    inputId: string;
    text: string;
    uploads: UserUpload[];
  } | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const callbacks = useRef({ onSnapshot, onRestoreDraft, t });
  callbacks.current = { onSnapshot, onRestoreDraft, t };
  useEffect(() => {
    if (!menuInputId) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        event.target.closest("[data-input-id]")?.getAttribute("data-input-id") !== menuInputId
      )
        setMenuInputId(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuInputId]);
  const apply = useCallback(
    (page: InputQueueResource) => {
      let next = page;
      if (
        !mounted.current ||
        next.sessionId !== sessionId ||
        (current.current && BigInt(next.viewVersion) < BigInt(current.current.viewVersion))
      )
        return;
      if (page.afterPosition > 0) {
        if (
          !current.current ||
          current.current.revision !== page.revision ||
          current.current.items.at(-1)?.mailboxPosition !== page.afterPosition
        )
          return;
        next = { ...page, afterPosition: 0, items: [...current.current.items, ...page.items] };
      } else if (
        current.current?.revision === page.revision &&
        current.current.items.length > page.items.length
      ) {
        next = { ...page, items: current.current.items, hasMore: current.current.hasMore };
      }
      const same =
        current.current?.revision === next.revision &&
        current.current.viewVersion === next.viewVersion &&
        current.current.activeTurnId === next.activeTurnId &&
        current.current.hasReturnedInputs === next.hasReturnedInputs &&
        current.current.hasMore === next.hasMore &&
        current.current.items.length === next.items.length &&
        current.current.items.every((item, index) => {
          const other = next.items[index]!;
          return (
            item.inputId === other.inputId &&
            item.text === other.text &&
            JSON.stringify(item.uploads ?? []) === JSON.stringify(other.uploads ?? []) &&
            item.status === other.status &&
            item.mailboxPosition === other.mailboxPosition
          );
        });
      current.current = next;
      if (!same) setQueue(next);
      callbacks.current.onSnapshot(next);
    },
    [sessionId],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal, force = false) => {
      if (inFlight.current || (readAbort.current && !force)) return;
      readAbort.current?.abort();
      const controller = new AbortController();
      readAbort.current = controller;
      const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const request = ++sequence.current;
      try {
        const next = await api.getInputQueue(sessionId, readSignal);
        if (mounted.current && request === sequence.current) {
          apply(next);
          setError((previous) => (previous === "queue.loadError" ? null : previous));
        }
      } catch {
        if (mounted.current && !readSignal.aborted && request === sequence.current)
          setError("queue.loadError");
      } finally {
        if (readAbort.current === controller) readAbort.current = undefined;
      }
    },
    [api, sessionId, apply],
  );
  useEffect(() => {
    mounted.current = true;
    const focus = () => {
      void refresh(undefined, true);
    };
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      readAbort.current?.abort();
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  useEffect(() => {
    if (streamQueue) apply(streamQueue);
  }, [streamQueue, apply]);
  useEffect(() => {
    void refresh(undefined, true);
  }, [refresh, refreshSignal]);

  async function loadMore(): Promise<void> {
    const snapshot = current.current;
    const last = snapshot?.items.at(-1);
    if (!snapshot?.hasMore || !last || inFlight.current) return;
    inFlight.current = true;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    const request = ++sequence.current;
    setBusy("page");
    let reload = false;
    try {
      const page = await api.getInputQueue(sessionId, controller.signal, {
        afterPosition: last.mailboxPosition,
        revision: snapshot.revision,
      });
      if (mounted.current && request === sequence.current) apply(page);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        reload = cause instanceof PiCloudApiError && cause.status === 409;
        setError(reload ? "queue.changed" : "queue.loadError");
      }
    } finally {
      inFlight.current = false;
      if (readAbort.current === controller) readAbort.current = undefined;
      if (mounted.current) {
        setBusy(null);
        if (reload) void refresh(undefined, true);
      }
    }
  }

  async function perform(inputId: string, action: Action): Promise<boolean> {
    const snapshot = current.current;
    if (!snapshot || inFlight.current || !canMutate) return false;
    if (action.action === "steer" && !snapshot.activeTurnId) {
      setError("queue.noActive");
      return false;
    }
    const request: QueuedInputAction = { ...action, revision: snapshot.revision };
    const key = newIdempotencyKey("turn");
    inFlight.current = true;
    sequence.current++;
    readAbort.current?.abort();
    setBusy(inputId);
    setError(null);
    let succeeded = false;
    const send = () => api.mutateQueuedInput(sessionId, inputId, request, key);
    try {
      let result;
      try {
        result = await send();
      } catch (first) {
        if (first instanceof PiCloudApiError && first.status < 500) throw first;
        // The same persisted command identity resolves a lost response safely.
        result = await send();
      }
      apply(result.queue);
      succeeded = true;
      return mounted.current;
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof PiCloudApiError && cause.status === 409
            ? "queue.changed"
            : "queue.actionError",
        );
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(null);
        if (!succeeded) void refresh(undefined, true);
      }
    }
  }

  const [returnStatus, setReturnStatus] = useState<"idle" | "pending" | "failed">("idle");
  const [returnRetry, retryReturns] = useState(0);
  useEffect(() => {
    if ((!queue?.hasReturnedInputs && !returnRecovery.requestId) || !canMutate) {
      // SSE may report the committed acknowledgement before its HTTP reply.
      // Cancelling that request must not leave the old waiting/error notice.
      setReturnStatus("idle");
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = async () => {
      try {
        const result = await restoreReturnedInputs(
          api,
          sessionId,
          returnRecovery,
          (items) =>
            callbacks.current.onRestoreDraft(
              items
                .map((item) => item.text)
                .filter(Boolean)
                .join("\n\n"),
              items.flatMap((item) => item.uploads),
              items.map((item) => item.idempotencyKey),
            ),
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setReturnStatus(result === "pending" ? "pending" : "idle");
        if (result === "pending") timer = setTimeout(() => void recover(), 1000);
        else void refresh(undefined, true);
      } catch {
        if (!abort.signal.aborted) setReturnStatus("failed");
      }
    };
    void recover();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    api,
    sessionId,
    canMutate,
    queue?.hasReturnedInputs,
    queue?.viewVersion,
    returnRecovery,
    returnRetry,
    refresh,
  ]);

  const editingItem = editing && queue?.items.find((item) => item.inputId === editing.inputId);
  const editable = editingItem?.status === "queued";
  const showAll = expanded || editing !== null;
  const visibleItems = showAll ? queue?.items : queue?.items.slice(0, 3);
  const editor = editing ? (
    <form
      className="pending-input-editor"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          // Keep the local edit when an action is still awaiting confirmation.
          if (busy === null) setEditing(null);
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (editable && (editing.text.trim() || editing.uploads.length))
          void perform(editing.inputId, { action: "edit", text: editing.text }).then((ok) => {
            if (ok) setEditing(null);
          });
      }}
    >
      {!editable ? <p role="status">{t("queue.draftKept")}</p> : null}
      <textarea
        aria-label={t("queue.editLabel")}
        value={editing.text}
        maxLength={100000}
        rows={2}
        autoFocus
        disabled={busy !== null}
        onChange={(event) => setEditing({ ...editing, text: event.target.value })}
      />
      <UploadCards api={api} uploads={editing.uploads} compact />
      <div className="pending-input-editor-actions">
        <button
          type="submit"
          disabled={
            !editable ||
            !canMutate ||
            busy !== null ||
            (!editing.text.trim() && !editing.uploads.length)
          }
        >
          {t("queue.save")}
        </button>
        <button
          type="button"
          disabled={
            !editable ||
            !canMutate ||
            busy !== null ||
            !queue?.activeTurnId ||
            (!editing.text.trim() && !editing.uploads.length)
          }
          onClick={() =>
            void perform(editing.inputId, { action: "steer", text: editing.text }).then((ok) => {
              if (ok) setEditing(null);
            })
          }
        >
          {t("queue.steer")}
        </button>
        {!editable ? (
          <button
            type="button"
            onClick={() => {
              if (callbacks.current.onRestoreDraft(editing.text, editing.uploads) !== false)
                setEditing(null);
            }}
          >
            {t("queue.restoreDraft")}
          </button>
        ) : null}
        <button type="button" disabled={busy !== null} onClick={() => setEditing(null)}>
          {t("queue.closeEdit")}
        </button>
      </div>
    </form>
  ) : null;
  if (!queue?.items.length && !editing && !error && returnStatus === "idle") return null;
  return (
    <section ref={root} className="pending-input-queue" aria-label={t("queue.title")}>
      <header>
        <strong>{t("queue.title")}</strong>
        <span>
          {queue?.items.length ?? 0}
          {queue?.hasMore ? "+" : ""}
        </span>
        {(queue?.items.length ?? 0) > 3 || queue?.hasMore ? (
          <button
            type="button"
            aria-expanded={showAll}
            aria-controls={listId}
            aria-label={t(showAll ? "queue.collapse" : "queue.expand")}
            title={t(showAll ? "queue.collapse" : "queue.expand")}
            disabled={editing !== null}
            onClick={() => {
              setExpanded(!showAll);
              setMenuInputId(null);
            }}
          >
            <span aria-hidden="true">{showAll ? "⌃" : "⌄"}</span>
          </button>
        ) : null}
      </header>
      {returnStatus === "pending" ? <p role="status">{t("queue.returnPending")}</p> : null}
      {returnStatus === "failed" ? (
        <p role="alert">
          {t("queue.returnError")}{" "}
          <button type="button" onClick={() => retryReturns((n) => n + 1)}>
            {t("queue.returnRetry")}
          </button>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="pending-input-error">
          {t(error)}{" "}
          <button type="button" aria-label={t("queue.dismiss")} onClick={() => setError(null)}>
            ×
          </button>
        </p>
      ) : null}
      <div id={listId} className="pending-input-list">
        {visibleItems?.map((item, index) => (
          <div
            className={`pending-input-row${editing?.inputId === item.inputId ? " editing" : ""}`}
            data-input-id={item.inputId}
            key={item.inputId}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                menuInputId === item.inputId
              )
                setMenuInputId(null);
            }}
            onKeyDown={(event) => {
              if (menuInputId !== item.inputId || event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setMenuInputId(null);
                event.currentTarget
                  .querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
                  ?.focus();
              }
              if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]:not(:disabled)',
                  ),
                ];
                const position = buttons.indexOf(document.activeElement as HTMLButtonElement);
                buttons[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (position + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) %
                        buttons.length
                ]?.focus();
              }
            }}
          >
            {editing?.inputId === item.inputId ? (
              editor
            ) : (
              <>
                <div className="pending-input-content">
                  <p title={item.text}>
                    {item.text.slice(0, 240)}
                    {item.text.length > 240 ? "…" : ""}
                  </p>
                  <UploadCards api={api} uploads={item.uploads ?? []} compact />
                </div>
                <div className="pending-input-actions" aria-busy={busy === item.inputId}>
                  {item.status === "steering" ? (
                    <span className="pending-input-status">{t("queue.steering")}</span>
                  ) : (
                    <button
                      type="button"
                      disabled={!canMutate || busy !== null || !queue?.activeTurnId}
                      onClick={() => void perform(item.inputId, { action: "steer" })}
                    >
                      {t("queue.steer")}
                    </button>
                  )}
                  <button
                    className="pending-input-more"
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuInputId === item.inputId}
                    aria-label={t("queue.actions")}
                    title={t("queue.actions")}
                    disabled={!canMutate || busy !== null || item.status !== "queued"}
                    onClick={() =>
                      setMenuInputId(menuInputId === item.inputId ? null : item.inputId)
                    }
                  >
                    ⋯
                  </button>
                </div>
                {menuInputId === item.inputId ? (
                  <div className="pending-input-menu" role="menu" aria-label={t("queue.actions")}>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canMutate || busy !== null || item.status !== "queued"}
                      onClick={() => {
                        setMenuInputId(null);
                        setEditing({
                          inputId: item.inputId,
                          text: item.text,
                          uploads: item.uploads ?? [],
                        });
                        setError(null);
                      }}
                    >
                      {t("queue.edit")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={
                        !canMutate ||
                        busy !== null ||
                        index === 0 ||
                        item.status !== "queued" ||
                        queue?.items[index - 1]?.status !== "queued"
                      }
                      onClick={() => {
                        setMenuInputId(null);
                        void perform(item.inputId, { action: "move", direction: "up" });
                      }}
                    >
                      {t("queue.up")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={
                        !canMutate ||
                        busy !== null ||
                        (index === queue!.items.length - 1 && !queue!.hasMore) ||
                        item.status !== "queued" ||
                        (index < queue!.items.length - 1 &&
                          queue!.items[index + 1]?.status !== "queued")
                      }
                      onClick={() => {
                        setMenuInputId(null);
                        void perform(item.inputId, { action: "move", direction: "down" });
                      }}
                    >
                      {t("queue.down")}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canMutate || busy !== null || item.status !== "queued"}
                      onClick={() => {
                        setMenuInputId(null);
                        void perform(item.inputId, { action: "cancel" });
                      }}
                    >
                      {t("queue.remove")}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
        {/* A consumed input or a superseded pagination view must not discard an edit. */}
        {editing && !editingItem ? editor : null}
      </div>
      {showAll && queue?.hasMore ? (
        <button type="button" disabled={busy !== null} onClick={() => void loadMore()}>
          {t("queue.more")}
        </button>
      ) : null}
    </section>
  );
}
