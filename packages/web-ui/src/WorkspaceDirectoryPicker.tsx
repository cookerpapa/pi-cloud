import { useEffect, useMemo, useState } from "react";
import type { DevelopmentEnvironmentDirectoryResource } from "@pi-cloud/protocol";
import { PiCloudApi } from "./api.ts";

function parent(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

export function WorkspaceDirectoryPicker({
  api,
  environmentId,
  initialDirectory,
  onCancel,
  onChoose,
  workspaceName,
}: {
  api: PiCloudApi;
  environmentId: string;
  initialDirectory: string;
  onCancel: () => void;
  onChoose: (directory: string) => void;
  workspaceName: string;
}) {
  const [directory, setDirectory] = useState(initialDirectory);
  const [listing, setListing] = useState<DevelopmentEnvironmentDirectoryResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .listDevelopmentEnvironmentDirectory(environmentId, directory)
      .then((resource) => {
        if (cancelled) return;
        setListing(resource);
        if (resource.path !== directory) setDirectory(resource.path);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setListing(null);
          setError(reason instanceof Error ? reason.message : "运行环境目录读取失败");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, directory, environmentId]);

  const parts = useMemo(
    () => (directory === "/" ? [] : directory.slice(1).split("/")),
    [directory],
  );

  return (
    <div className="product-modal-backdrop product-directory-picker-backdrop" role="presentation">
      <section className="product-workspace-modal product-directory-picker">
        <header>
          <div>
            <h2>选择机器工作目录</h2>
            <p>{workspaceName} 的实时文件系统；空目录和普通文件也会显示。</p>
          </div>
          <button onClick={onCancel} type="button">
            ×
          </button>
        </header>
        <div className="product-directory-address">
          <button onClick={() => setDirectory("/")} type="button">
            🖥️ /
          </button>
          {parts.map((part, index) => {
            const target = `/${parts.slice(0, index + 1).join("/")}`;
            return (
              <button key={target} onClick={() => setDirectory(target)} type="button">
                / {part}
              </button>
            );
          })}
        </div>
        <div className="product-directory-toolbar">
          <button
            disabled={directory === "/"}
            onClick={() => setDirectory(parent(directory))}
            type="button"
          >
            ← 上一级
          </button>
          <code>{directory}</code>
        </div>
        <div className="product-directory-browser">
          {loading ? <span>正在读取机器目录…</span> : null}
          {error === null ? null : <span className="product-form-error">{error}</span>}
          {!loading && error === null && listing?.entries.length === 0 ? (
            <span className="product-empty-directory">这是一个空目录，可以直接选择</span>
          ) : null}
          {listing?.entries.map((entry) => (
            <button
              className={`product-directory-entry product-directory-entry-${entry.kind}`}
              disabled={entry.kind !== "directory"}
              key={entry.path}
              onDoubleClick={() => {
                if (entry.kind === "directory") setDirectory(entry.path);
              }}
              type="button"
            >
              <span>
                {entry.kind === "directory" ? "📁" : entry.kind === "symlink" ? "🔗" : "📄"}
              </span>
              <strong>{entry.name}</strong>
              <small>{entry.kind === "directory" ? "双击打开" : sizeLabel(entry.sizeBytes)}</small>
            </button>
          ))}
        </div>
        <div className="product-directory-selection">当前选择：{directory}</div>
        <footer>
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="product-primary-button"
            onClick={() => onChoose(directory)}
            type="button"
          >
            选择此目录
          </button>
        </footer>
      </section>
    </div>
  );
}
