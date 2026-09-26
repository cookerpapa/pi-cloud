import { useCallback, useEffect, useRef, useState } from "react";
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
  onSnapshot,
  onRestoreDraft,
}: {
  api: PiCloudApi;
  sessionId: string;
  canMutate: boolean;
  refreshSignal: string;
  onSnapshot: (queue: InputQueueResource) => void;
  onRestoreDraft: (text: string) => void;
}) {
  const { t } = useI18n();
  const [queue, setQueue] = useState<InputQueueResource | null>(null);
  const current = useRef<InputQueueResource | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const readAbort = useRef<AbortController | undefined>(undefined);
  const [error, setError] = useState<
    "queue.loadError" | "queue.actionError" | "queue.changed" | "queue.noActive" | null
  >(null);
  const [editing, setEditing] = useState<{ turnId: string; text: string } | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const callbacks = useRef({ onSnapshot, onRestoreDraft, t });
  callbacks.current = { onSnapshot, onRestoreDraft, t };
  const apply = useCallback(
    (next: InputQueueResource) => {
      if (
        !mounted.current ||
        next.sessionId !== sessionId ||
        (current.current && next.revision < current.current.revision)
      )
        return;
      const same =
        current.current?.revision === next.revision &&
        current.current.activeTurnId === next.activeTurnId &&
        current.current.items.length === next.items.length &&
        current.current.items.every((item, index) => {
          const other = next.items[index]!;
          return (
            item.turnId === other.turnId &&
            item.text === other.text &&
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
    const controller = new AbortController();
    const tick = () => {
      if (!document.hidden) void refresh(controller.signal);
    };
    const timer = setInterval(tick, 2000);
    const focus = () => {
      void refresh(controller.signal, true);
    };
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      controller.abort();
      readAbort.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh]);
  useEffect(() => {
    void refresh(undefined, true);
  }, [refresh, refreshSignal]);

  async function perform(turnId: string, action: Action): Promise<boolean> {
    const snapshot = current.current;
    if (!snapshot || inFlight.current || !canMutate) return false;
    if (action.action === "steer" && !snapshot.activeTurnId) {
      setError("queue.noActive");
      return false;
    }
    const request: QueuedInputAction =
      action.action === "steer"
        ? { ...action, revision: snapshot.revision, targetTurnId: snapshot.activeTurnId! }
        : { ...action, revision: snapshot.revision };
    const key = newIdempotencyKey("turn");
    inFlight.current = true;
    sequence.current++;
    readAbort.current?.abort();
    setBusy(turnId);
    setError(null);
    try {
      let result;
      try {
        result = await api.mutateQueuedInput(sessionId, turnId, request, key);
      } catch (first) {
        if (first instanceof PiCloudApiError && first.status < 500) throw first;
        // The same persisted command identity resolves a lost response safely.
        result = await api.mutateQueuedInput(sessionId, turnId, request, key);
      }
      apply(result.queue);
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
        void refresh(undefined, true);
      }
    }
  }

  const editingItem = editing && queue?.items.find((item) => item.turnId === editing.turnId);
  const editable = editingItem?.status === "queued";
  if (!queue?.items.length && !editing && !error) return null;
  return (
    <section className="pending-input-queue" aria-label={t("queue.title")}>
      <header>
        <strong>{t("queue.title")}</strong>
        <span>{queue?.items.length ?? 0}</span>
        <small>{t("queue.hint")}</small>
      </header>
      {error ? (
        <p role="alert" className="pending-input-error">
          {t(error)}{" "}
          <button type="button" aria-label={t("queue.dismiss")} onClick={() => setError(null)}>
            ×
          </button>
        </p>
      ) : null}
      <div className="pending-input-list">
        {queue?.items.map((item, index) => (
          <div
            className={`pending-input-row${editing?.turnId === item.turnId ? " editing" : ""}`}
            data-turn-id={item.turnId}
            key={item.turnId}
          >
            <span className="pending-input-number">{index + 1}</span>
            <div className="pending-input-content">
              <p>
                {item.text.slice(0, 240)}
                {item.text.length > 240 ? "…" : ""}
              </p>
              {item.status === "steering" ? (
                <small className="pending-input-status">{t("queue.steering")}</small>
              ) : null}
            </div>
            <div className="pending-input-actions">
              <button
                type="button"
                title={t("queue.up")}
                aria-label={t("queue.up")}
                disabled={
                  !canMutate ||
                  busy !== null ||
                  index === 0 ||
                  item.status !== "queued" ||
                  queue.items[index - 1]?.status !== "queued"
                }
                onClick={() => void perform(item.turnId, { action: "move", direction: "up" })}
              >
                ↑
              </button>
              <button
                type="button"
                title={t("queue.down")}
                aria-label={t("queue.down")}
                disabled={
                  !canMutate ||
                  busy !== null ||
                  index === queue.items.length - 1 ||
                  item.status !== "queued" ||
                  queue.items[index + 1]?.status !== "queued"
                }
                onClick={() => void perform(item.turnId, { action: "move", direction: "down" })}
              >
                ↓
              </button>
              <button
                type="button"
                disabled={!canMutate || busy !== null || item.status !== "queued"}
                onClick={() => {
                  setEditing({ turnId: item.turnId, text: item.text });
                  setError(null);
                }}
              >
                {t("queue.edit")}
              </button>
              <button
                type="button"
                disabled={
                  !canMutate ||
                  busy !== null ||
                  item.status !== "queued" ||
                  queue.activeTurnId === null
                }
                onClick={() => void perform(item.turnId, { action: "steer" })}
              >
                {t("queue.steer")}
              </button>
              <button
                type="button"
                disabled={!canMutate || busy !== null || item.status !== "queued"}
                onClick={() => void perform(item.turnId, { action: "cancel" })}
              >
                {t("queue.remove")}
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing ? (
        <form
          className="pending-input-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (editable)
              void perform(editing.turnId, { action: "edit", text: editing.text }).then((ok) => {
                if (ok) setEditing(null);
              });
          }}
        >
          {!editable ? <p role="status">{t("queue.draftKept")}</p> : null}
          <strong className="pending-input-edit-title">
            {t("queue.editLabel")}
            {editingItem
              ? ` ${queue!.items.findIndex((item) => item.turnId === editing.turnId) + 1}`
              : ""}
          </strong>
          <textarea
            aria-label={t("queue.editLabel")}
            value={editing.text}
            maxLength={100000}
            rows={3}
            autoFocus
            disabled={busy !== null}
            onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          />
          <div className="pending-input-editor-actions">
            <button
              type="submit"
              disabled={!editable || !canMutate || busy !== null || !editing.text.trim()}
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
                !editing.text.trim()
              }
              onClick={() =>
                void perform(editing.turnId, { action: "steer", text: editing.text }).then((ok) => {
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
                  callbacks.current.onRestoreDraft(editing.text);
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
      ) : null}
    </section>
  );
}
