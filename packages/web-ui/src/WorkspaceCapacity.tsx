import { useEffect, useState } from "react";
import type { WorkspaceCapacitySnapshot } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";

export function WorkspaceCapacity({
  api,
  workspaceId,
  canGrow = false,
  defer = false,
}: {
  api: PiCloudApi;
  workspaceId: string;
  canGrow?: boolean;
  defer?: boolean;
}) {
  const { language } = useI18n(),
    say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const [opened, setOpened] = useState(!defer);
  const [value, setValue] = useState<WorkspaceCapacitySnapshot>(),
    [editing, setEditing] = useState(false),
    [minimum, setMinimum] = useState(64);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => {
    if (!opened) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await api.workspaceCapacity(workspaceId, abort.signal);
        if (!abort.signal.aborted) {
          setValue(next);
          if (next.pending)
            timer = setTimeout(() => {
              void read();
            }, 2000);
        }
      } catch {
        if (!abort.signal.aborted)
          setError(say("暂时无法读取容量设置", "Capacity settings are temporarily unavailable"));
      }
    };
    void read();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, workspaceId, busy, opened]);
  if (!opened)
    return (
      <button type="button" className="product-secondary-button" onClick={() => setOpened(true)}>
        {say("查看容量", "Storage capacity")}
      </button>
    );
  const gib = value ? value.capacityBytes / 1024 ** 3 : undefined;
  return (
    <div className="workspace-capacity-control">
      {value ? (
        <span>
          {say("工作区容量", "Workspace capacity")} · {gib} GiB
          {value.pending ? ` · ${say("调整中", "Applying")}` : ""}
        </span>
      ) : null}
      {canGrow && value && !editing ? (
        <button
          type="button"
          onClick={() => {
            setMinimum(Math.max(64, Math.ceil(gib! * 2)));
            setEditing(true);
          }}
        >
          {say("扩容", "Grow")}
        </button>
      ) : null}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!Number.isSafeInteger(minimum) || minimum < 1) return;
            setBusy(true);
            setError(undefined);
            void api
              .growWorkspaceCapacity(workspaceId, minimum)
              .then((next) => {
                setValue(next);
                setEditing(false);
              })
              .catch(() =>
                setError(say("容量设置未保存，请重试", "Capacity settings were not saved; retry")),
              )
              .finally(() => setBusy(false));
          }}
        >
          <input
            type="number"
            aria-label={say("目标容量（GiB）", "Target capacity (GiB)")}
            min={Math.ceil(gib ?? 1)}
            step="1"
            value={minimum}
            onChange={(event) => setMinimum(Number(event.target.value))}
          />
          <button type="submit" disabled={busy}>
            {say("确认", "Apply")}
          </button>
          <button type="button" disabled={busy} onClick={() => setEditing(false)}>
            {say("取消", "Cancel")}
          </button>
        </form>
      ) : null}
      {error ? <small role="alert">{error}</small> : null}
    </div>
  );
}
