import { useEffect, useState } from "react";
import type { ConversationSummaryResource, ExecutionTargetResource } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";

/** Existing devices are connected to Sessions, never presented as Linux VMs. */
export function ResourceDevices({
  api,
  conversations,
  onRefresh,
}: {
  api: PiCloudApi;
  conversations: readonly ConversationSummaryResource[];
  onRefresh(): Promise<void>;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const [devices, setDevices] = useState<readonly ExecutionTargetResource[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false,
      active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (stopped || active || document.hidden) return;
      active = true;
      try {
        const result = await api.listExecutionTargets();
        if (!stopped) setDevices(result.targets);
      } catch {
        /* Retain last registered-device directory; no offline inference. */
      } finally {
        active = false;
        if (timer) clearTimeout(timer);
        if (!stopped) timer = setTimeout(() => void refresh(), 15_000);
      }
    };
    const wake = () => {
      void refresh();
    };
    wake();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [api]);
  if (!devices.length) return null;
  const change = async (device: ExecutionTargetResource) => {
    const sessionId = device.boundSessionId ?? selected[device.targetId];
    if (!sessionId || busy) return;
    setBusy(device.targetId);
    setError("");
    try {
      const selection = await api.getSessionExecutionTarget(sessionId);
      await api.bindExecutionTarget(
        sessionId,
        device.boundSessionId ? null : device.targetId,
        selection.revision,
      );
      setDevices((await api.listExecutionTargets()).targets);
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Device binding failed");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="product-resource-section resource-devices">
      <h2>{zh ? "已登记设备" : "Registered devices"}</h2>
      {devices.map((device) => {
        const bound = conversations.find((c) => c.sessionId === device.boundSessionId);
        const active = bound && ["running", "cancelling"].includes(bound.state);
        return (
          <div className="admin-settings-row" key={device.targetId}>
            <span>
              {device.name} · {device.kind === "linux" ? "Linux" : "Android"}
              {device.computeBilling === "external"
                ? zh
                  ? " · 自有算力"
                  : " · User-provided compute"
                : ""}
              {bound ? ` · ${bound.title}` : ""}
            </span>
            {!device.boundSessionId && (
              <select
                aria-label={`${device.name} ${zh ? "会话" : "conversation"}`}
                value={selected[device.targetId] ?? ""}
                onChange={(e) =>
                  setSelected((current) => ({ ...current, [device.targetId]: e.target.value }))
                }
              >
                <option value="">{zh ? "选择空闲会话" : "Choose an idle conversation"}</option>
                {conversations
                  .filter((c) => !["running", "cancelling"].includes(c.state))
                  .map((c) => (
                    <option key={c.sessionId} value={c.sessionId}>
                      {c.title}
                    </option>
                  ))}
              </select>
            )}
            <button
              type="button"
              disabled={
                !!busy || !!active || (!device.boundSessionId && !selected[device.targetId])
              }
              onClick={() => void change(device)}
            >
              {device.boundSessionId
                ? zh
                  ? "解除绑定"
                  : "Disconnect"
                : zh
                  ? "绑定会话"
                  : "Connect"}
            </button>
          </div>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
