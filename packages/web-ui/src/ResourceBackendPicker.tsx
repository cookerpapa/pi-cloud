import { useEffect, useRef, useState } from "react";
import type {
  CreateDevelopmentEnvironmentRequest,
  ResourceBackendResource,
} from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";

type Selection = CreateDevelopmentEnvironmentRequest["backend"];
export function ResourceBackendPicker({
  api,
  value,
  onChange,
}: {
  api: PiCloudApi;
  value: Selection;
  onChange(value: Selection): void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [backends, setBackends] = useState<readonly ResourceBackendResource[]>([]);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const initialized = useRef(false);
  useEffect(() => {
    let stopped = false,
      active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (stopped || active || document.hidden) return;
      active = true;
      try {
        const response = await api.resourceBackends();
        if (!stopped) {
          setBackends(response.backends);
          setLoaded(true);
          setError(false);
        }
      } catch {
        if (!stopped) setError(true);
      } finally {
        active = false;
        if (timer) clearTimeout(timer);
        if (!stopped) timer = setTimeout(() => void refresh(), 15_000);
      }
    };
    const wake = () => {
      void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [api]);
  useEffect(() => {
    if (!initialized.current && backends.length) {
      initialized.current = true;
      if (!value)
        onChange({
          id: backends[0]!.id,
          templateId: backends[0]!.templates[0]!.id,
          revision: backends[0]!.revision,
        });
    }
  }, [backends, value, onChange]);
  const selected = backends.find((b) => b.id === value?.id);
  const select = (id: string, templateId?: string) => {
    const backend = backends.find((b) => b.id === id);
    if (backend)
      onChange({
        id,
        revision: backend.revision,
        templateId: templateId ?? backend.templates[0]!.id,
      });
  };
  useEffect(() => {
    if (
      selected &&
      value &&
      selected.revision !== value.revision &&
      selected.templates.some((t) => t.id === value.templateId)
    )
      onChange({ ...value, revision: selected.revision });
    else if (value && loaded && !selected) onChange(undefined);
  }, [selected, value, loaded, onChange]);
  return (
    <>
      <label>
        <span>{zh ? "集群" : "Backend"}</span>
        <select
          aria-label={zh ? "集群" : "Backend"}
          value={value?.id ?? ""}
          onChange={(e) => select(e.target.value)}
        >
          <option value="" disabled>
            {error
              ? zh
                ? "暂时无法获取集群"
                : "Backends unavailable"
              : zh
                ? "选择集群"
                : "Choose backend"}
          </option>
          {backends.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} · {b.location} · {b.provider}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{zh ? "环境" : "Environment"}</span>
        <select
          aria-label={zh ? "环境" : "Environment"}
          value={value?.templateId ?? ""}
          disabled={!selected}
          onChange={(e) => selected && select(selected.id, e.target.value)}
        >
          {!selected && <option value="">—</option>}
          {selected?.templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.operatingSystem}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
