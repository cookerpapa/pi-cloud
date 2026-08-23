import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileResource } from "@pi-cloud/protocol";
import { PiCloudApi } from "./api.ts";

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function directorySet(files: readonly WorkspaceFileResource[]): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories].sort((left, right) => left.localeCompare(right));
}

export function WorkspaceDirectoryPicker({
  api,
  initialDirectory,
  onCancel,
  onChoose,
  referenceSessionId,
  workspaceName,
}: {
  api: PiCloudApi;
  initialDirectory: string;
  onCancel: () => void;
  onChoose: (directory: string) => void;
  referenceSessionId: string | null;
  workspaceName: string;
}) {
  const initialRelative = initialDirectory === "/workspace" ? "" : initialDirectory.slice(11);
  const [directory, setDirectory] = useState(initialRelative);
  const [directories, setDirectories] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(referenceSessionId !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (referenceSessionId === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const versions = await api.listWorkspaceVersions(referenceSessionId);
        const current = versions.versions.find(
          (version) => version.versionId === versions.currentVersionId,
        );
        if (current === undefined) return;
        const files: WorkspaceFileResource[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.listWorkspaceFiles(current.versionId, cursor);
          files.push(...page.files);
          cursor = page.truncated ? page.nextCursor : undefined;
        } while (cursor !== undefined);
        if (!cancelled) setDirectories(directorySet(files));
      } catch (reason: unknown) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "工作目录读取失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, referenceSessionId]);

  const children = useMemo(
    () => directories.filter((path) => parent(path) === directory),
    [directories, directory],
  );
  const parts = directory === "" ? [] : directory.split("/");
  const selected = directory === "" ? "/workspace" : `/workspace/${directory}`;

  return (
    <div className="product-modal-backdrop product-directory-picker-backdrop" role="presentation">
      <section className="product-workspace-modal product-directory-picker">
        <header>
          <div>
            <h2>选择工作目录</h2>
            <p>{workspaceName} 的持久文件卷；根目录在沙箱中挂载为 /workspace。</p>
          </div>
          <button onClick={onCancel} type="button">
            ×
          </button>
        </header>
        <div className="product-directory-address">
          <button onClick={() => setDirectory("")} type="button">
            🏠 ~
          </button>
          {parts.map((part, index) => {
            const target = parts.slice(0, index + 1).join("/");
            return (
              <button key={target} onClick={() => setDirectory(target)} type="button">
                / {part}
              </button>
            );
          })}
        </div>
        <div className="product-directory-browser">
          {loading ? <span>正在读取目录…</span> : null}
          {error === null ? null : <span className="product-form-error">{error}</span>}
          {!loading && children.length === 0 ? (
            <span className="product-empty-directory">此目录没有可选择的子目录</span>
          ) : null}
          {children.map((path) => (
            <button key={path} onDoubleClick={() => setDirectory(path)} type="button">
              <span>📁</span>
              <strong>{path.split("/").at(-1)}</strong>
              <small>双击打开</small>
            </button>
          ))}
        </div>
        <div className="product-directory-selection">当前选择：{selected}</div>
        <footer>
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="product-primary-button"
            onClick={() => onChoose(selected)}
            type="button"
          >
            选择此目录
          </button>
        </footer>
      </section>
    </div>
  );
}
