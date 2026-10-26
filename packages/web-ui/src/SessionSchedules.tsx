import { useEffect, useState } from "react";
import type {
  ScheduleChange,
  ScheduleTiming,
  SessionSchedule,
  SessionScheduleSummary,
  ScheduleDeletion,
} from "@pi-cloud/protocol";
import { type PiCloudApi, newIdempotencyKey } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { errorMessage } from "./ui-errors.ts";

type Editor = {
  original: SessionSchedule;
  name: string;
  prompt: string;
  kind: "once" | "daily" | "weekly" | "cron";
  date: string;
  time: string;
  day: string;
  expression: string;
  timezone: string;
  missed: "latest" | "skip";
};
const pad = (n: number) => String(n).padStart(2, "0");
function localInput(at: string) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}
function edit(value: SessionSchedule): Editor {
  const t = value.timing,
    match = t.kind === "cron" ? /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/.exec(t.expression) : null;
  return {
    original: value,
    name: value.name,
    prompt: value.prompt,
    kind: t.kind === "once" ? "once" : match ? (match[3] === "*" ? "daily" : "weekly") : "cron",
    date: t.kind === "once" ? localInput(t.at) : "",
    time: match ? `${pad(Number(match[2]))}:${pad(Number(match[1]))}` : "08:00",
    day: match && match[3] !== "*" ? String(Number(match[3]) % 7) : "1",
    expression: t.kind === "cron" ? t.expression : "0 8 * * *",
    timezone: t.kind === "cron" ? t.timezone : "Asia/Shanghai",
    missed: value.missed,
  };
}
function timing(e: Editor): ScheduleTiming {
  if (e.kind === "once") {
    // Keep the exact instant when the form value is unchanged (including a repeated DST hour).
    if (e.original.timing.kind === "once" && e.date === localInput(e.original.timing.at))
      return e.original.timing;
    return { kind: "once", at: new Date(e.date).toISOString() };
  }
  const [hour, minute] = e.time.split(":").map(Number);
  return {
    kind: "cron",
    expression:
      e.kind === "cron"
        ? e.expression
        : `${minute} ${hour} * * ${e.kind === "daily" ? "*" : e.day}`,
    timezone: e.timezone,
  };
}
export function SessionSchedules({
  api,
  sessionId,
  canMutate,
  onClose,
  onOpenRun,
}: {
  api: PiCloudApi;
  sessionId: string;
  canMutate: boolean;
  onClose(): void;
  onOpenRun?(turnId: string): void;
}) {
  const { t, language } = useI18n();
  const [rows, setRows] = useState<SessionScheduleSummary[]>([]),
    [cursor, setCursor] = useState<string | undefined>(),
    [back, setBack] = useState<(string | undefined)[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [revision, setRevision] = useState(0),
    [editor, setEditor] = useState<Editor | null>(null),
    [deleted, setDeleted] = useState<ScheduleDeletion | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void api
      .listSchedules(sessionId, cursor, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setRows(value.schedules);
          setNext(value.nextCursor);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorMessage(e, t));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, sessionId, cursor, revision, t]);
  const refresh = () => setRevision((n) => n + 1);
  async function act(id: string, work: () => Promise<unknown>) {
    if (busy || !canMutate) return;
    setBusy(id);
    setError(null);
    try {
      await work();
      refresh();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(null);
    }
  }
  const stamp = (value: string, zone?: string) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(zone ? { timeZone: zone } : {}),
    }).format(new Date(value));
  const status = (value: string) =>
    ({
      scheduled: t("schedule.scheduled"),
      paused: t("schedule.paused"),
      waiting: t("schedule.waiting"),
      blocked: t("schedule.blocked"),
      finished: t("schedule.finished"),
      queued: t("schedule.queued"),
      running: t("schedule.running"),
      cancelling: t("schedule.cancelling"),
      completed: t("schedule.completed"),
      failed: t("schedule.failed"),
      cancelled: t("schedule.cancelled"),
      timed_out: t("schedule.failed"),
      settling: t("schedule.settling"),
    })[value] ?? value;
  async function save() {
    if (!editor) return;
    const e = editor;
    await act(e.original.id, async () => {
      const proposed = timing(e),
        patch: Extract<ScheduleChange, { action: "update" }>["patch"] = {};
      if (e.name !== e.original.name) patch.name = e.name;
      if (e.prompt !== e.original.prompt) patch.prompt = e.prompt;
      if (JSON.stringify(proposed) !== JSON.stringify(e.original.timing)) patch.timing = proposed;
      if (e.missed !== e.original.missed) patch.missed = e.missed;
      if (Object.keys(patch).length)
        await api.changeSchedule(sessionId, e.original.id, {
          action: "update",
          revision: e.original.revision,
          patch,
        });
      setEditor(null);
    });
  }
  return (
    <div className="product-modal-backdrop" role="presentation">
      <section
        className="product-workspace-modal product-schedules-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("schedule.title")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="product-modal-heading">
          <h2>{t("schedule.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {deleted ? (
          <div role="status" className="product-schedule-notice">
            {deleted.activeRun ? t("schedule.deletedActive") : t("schedule.deleted")}
            {deleted.activeRun && canMutate ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void act(deleted.id, async () => {
                    await api.cancelTurn(
                      sessionId,
                      deleted.activeRun!.turnId,
                      newIdempotencyKey("cancel"),
                    );
                    setDeleted({ ...deleted, activeRun: null });
                  })
                }
              >
                {t("schedule.stop")}
              </button>
            ) : null}
          </div>
        ) : null}
        {editor ? (
          <form
            className="product-schedule-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              {t("schedule.name")}
              <input
                value={editor.name}
                maxLength={128}
                required
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>
            <label>
              {t("schedule.prompt")}
              <textarea
                value={editor.prompt}
                required
                rows={5}
                onChange={(e) => setEditor({ ...editor, prompt: e.target.value })}
              />
            </label>
            <label>
              {t("schedule.frequency")}
              <select
                value={editor.kind}
                onChange={(e) => setEditor({ ...editor, kind: e.target.value as Editor["kind"] })}
              >
                <option value="once">{t("schedule.once")}</option>
                <option value="daily">{t("schedule.daily")}</option>
                <option value="weekly">{t("schedule.weekly")}</option>
                <option value="cron">{t("schedule.custom")}</option>
              </select>
            </label>
            {editor.kind === "once" ? (
              <label>
                {t("schedule.time")} · {Intl.DateTimeFormat().resolvedOptions().timeZone}
                <input
                  type="datetime-local"
                  step="any"
                  required
                  value={editor.date}
                  onChange={(e) => setEditor({ ...editor, date: e.target.value })}
                />
              </label>
            ) : (
              <>
                {editor.kind === "cron" ? (
                  <label>
                    {t("schedule.expression")}
                    <input
                      required
                      value={editor.expression}
                      onChange={(e) => setEditor({ ...editor, expression: e.target.value })}
                    />
                  </label>
                ) : (
                  <label>
                    {t("schedule.time")}
                    <input
                      type="time"
                      required
                      value={editor.time}
                      onChange={(e) => setEditor({ ...editor, time: e.target.value })}
                    />
                  </label>
                )}
                {editor.kind === "weekly" ? (
                  <label>
                    {t("schedule.weekday")}
                    <select
                      value={editor.day}
                      onChange={(e) => setEditor({ ...editor, day: e.target.value })}
                    >
                      {["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((key, i) => (
                        <option key={key} value={String(i)}>
                          {t(`schedule.${key}` as Parameters<typeof t>[0])}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  {t("schedule.timezone")}
                  <input
                    required
                    value={editor.timezone}
                    onChange={(e) => setEditor({ ...editor, timezone: e.target.value })}
                  />
                </label>
              </>
            )}
            <label>
              {t("schedule.missed")}
              <select
                value={editor.missed}
                onChange={(e) =>
                  setEditor({ ...editor, missed: e.target.value as Editor["missed"] })
                }
              >
                <option value="latest">{t("schedule.latest")}</option>
                <option value="skip">{t("schedule.skip")}</option>
              </select>
            </label>
            <div className="product-schedule-actions">
              <button type="submit" disabled={!!busy || !canMutate}>
                {t("common.save")}
              </button>
              <button type="button" disabled={!!busy} onClick={() => setEditor(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="product-schedule-toolbar">
              <button type="button" disabled={loading} onClick={refresh}>
                {t("schedule.refresh")}
              </button>
            </div>
            {loading ? (
              <p className="product-muted-line">{t("common.loading")}</p>
            ) : !rows.length ? (
              <p className="product-muted-line">{t("schedule.empty")}</p>
            ) : null}
            {!loading
              ? rows.map((row) => (
                  <article key={row.id} className="product-schedule-card" data-schedule-id={row.id}>
                    <div className="product-schedule-heading">
                      <strong>{row.name}</strong>
                      <span>{status(row.state)}</span>
                    </div>
                    {row.nextFireAt ? (
                      <p>
                        {t("schedule.next")}{" "}
                        {stamp(
                          row.nextFireAt,
                          row.timing.kind === "cron" ? row.timing.timezone : undefined,
                        )}
                        {row.timing.kind === "cron" ? ` · ${row.timing.timezone}` : ""}
                      </p>
                    ) : null}
                    {row.lastRun ? (
                      <p>
                        {t("schedule.last")} {status(row.lastRun.state)}
                        {onOpenRun && row.lastRun.state !== "queued" ? (
                          <button type="button" onClick={() => onOpenRun(row.lastRun!.turnId)}>
                            {t("schedule.view")}
                          </button>
                        ) : null}
                      </p>
                    ) : null}
                    {row.lastSkippedAt ? (
                      <p className="product-muted-line">
                        {t("schedule.skipped")} {stamp(row.lastSkippedAt)}
                      </p>
                    ) : null}
                    {row.error ? <p role="status">{row.error.message}</p> : null}
                    {canMutate ? (
                      <div className="product-schedule-actions">
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() =>
                            void act(row.id, async () =>
                              setEditor(edit(await api.getSchedule(sessionId, row.id))),
                            )
                          }
                        >
                          {t("schedule.edit")}
                        </button>
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() =>
                            void act(row.id, () =>
                              api.changeSchedule(sessionId, row.id, {
                                action: ["scheduled", "waiting"].includes(row.state)
                                  ? "pause"
                                  : "resume",
                                revision: row.revision,
                              }),
                            )
                          }
                        >
                          {["scheduled", "waiting"].includes(row.state)
                            ? t("schedule.pause")
                            : t("schedule.resume")}
                        </button>
                        {row.lastRun &&
                        ["queued", "running", "cancelling"].includes(row.lastRun.state) ? (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={() =>
                              void act(row.id, () =>
                                api.cancelTurn(
                                  sessionId,
                                  row.lastRun!.turnId,
                                  newIdempotencyKey("cancel"),
                                ),
                              )
                            }
                          >
                            {t("schedule.stop")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() =>
                            void act(row.id, async () =>
                              setDeleted(await api.deleteSchedule(sessionId, row.id, row.revision)),
                            )
                          }
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))
              : null}
            {back.length || next ? (
              <div className="product-schedule-actions">
                <button
                  type="button"
                  disabled={loading || !back.length}
                  onClick={() => {
                    setCursor(back.at(-1));
                    setBack(back.slice(0, -1));
                  }}
                >
                  {t("schedule.previous")}
                </button>
                <button
                  type="button"
                  disabled={loading || !next}
                  onClick={() => {
                    setBack([...back, cursor]);
                    setCursor(next!);
                  }}
                >
                  {t("schedule.more")}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
