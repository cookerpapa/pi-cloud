import { useEffect, useState, useRef } from "react";
import type { ExecutionTargetResource, SessionExecutionTarget } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { errorMessage } from "./ui-errors.ts";

export function ExecutionTargetPicker({
  api,
  sessionId,
  busyRun,
  canMutate,
  onClose,
}: {
  api: PiCloudApi;
  sessionId: string;
  busyRun: boolean;
  canMutate: boolean;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<ExecutionTargetResource[]>([]),
    [selection, setSelection] = useState<SessionExecutionTarget | null>(null);
  const [chosen, setChosen] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [image, setImage] = useState<string | null>(null);
  const generation = useRef(0),
    imageUrl = useRef<string | null>(null),
    request = useRef<AbortController | null>(null);
  useEffect(() => {
    const version = ++generation.current;
    void Promise.all([api.listExecutionTargets(), api.getSessionExecutionTarget(sessionId)])
      .then(([list, current]) => {
        if (generation.current !== version) return;
        setTargets(list.targets);
        setSelection(current);
        setChosen(current.target?.targetId ?? "");
      })
      .catch((e) => {
        if (generation.current === version) setError(errorMessage(e, t));
      });
    return () => {
      generation.current++;
      request.current?.abort();
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    };
  }, [api, sessionId, t]);
  async function save() {
    if (!selection || busyRun || !canMutate) return;
    setBusy(true);
    setError(null);
    const version = generation.current;
    try {
      const current = await api.bindExecutionTarget(sessionId, chosen || null, selection.revision);
      if (generation.current !== version) return;
      setSelection(current);
      setChosen(current.target?.targetId ?? "");
    } catch (e) {
      if (generation.current === version) setError(errorMessage(e, t));
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }
  async function screen() {
    if (!chosen) return;
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setError(null);
    try {
      const value = await api.readExecutionTargetScreen(chosen, abort.signal);
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([value.bytes as BlobPart], { type: value.contentType }),
      );
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = url;
      setImage(url);
    } catch (e) {
      if (!abort.signal.aborted) setError(errorMessage(e, t));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="product-modal-backdrop" role="presentation">
      <section
        className="product-workspace-modal product-device-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("device.title")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="product-modal-heading">
          <h2>{t("device.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("common.close")}>
            ×
          </button>
        </div>
        <label>
          {t("device.choose")}
          <select
            value={chosen}
            disabled={!selection || busy || busyRun || !canMutate}
            onChange={(event) => {
              request.current?.abort();
              if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
              imageUrl.current = null;
              setImage(null);
              setChosen(event.target.value);
            }}
          >
            <option value="">{t("device.none")}</option>
            {targets.map((target) => (
              <option
                key={target.targetId}
                value={target.targetId}
                disabled={Boolean(target.boundSessionId && target.boundSessionId !== sessionId)}
              >
                {target.name}
                {target.boundSessionId && target.boundSessionId !== sessionId
                  ? " · " + t("device.inUse")
                  : ""}
              </option>
            ))}
          </select>
        </label>
        {selection && targets.length === 0 ? (
          <p className="product-muted-line">{t("device.empty")}</p>
        ) : null}
        {busyRun ? <p className="product-muted-line">{t("device.waitIdle")}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="product-device-actions">
          <button type="button" disabled={busy || !chosen} onClick={() => void screen()}>
            {t("device.screen")}
          </button>
          <button
            type="button"
            disabled={
              busy ||
              busyRun ||
              !canMutate ||
              !selection ||
              chosen === (selection.target?.targetId ?? "")
            }
            onClick={() => void save()}
          >
            {t("common.save")}
          </button>
        </div>
        {image ? (
          <img className="product-device-screen" src={image} alt={t("device.screen")} />
        ) : null}
      </section>
    </div>
  );
}
