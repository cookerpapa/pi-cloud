import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceDirectoryEntryResource } from "@pi-cloud/protocol";
import { PiCloudApi, PiCloudApiError } from "./api.ts";
import { useI18n, type Translate } from "./i18n.tsx";

const WorkspaceTerminal = lazy(async () => {
  const module = await import("./WorkspaceTerminal.tsx");
  return { default: module.WorkspaceTerminal };
});

export const MAXIMUM_WORKSPACE_PREVIEW_BYTES = 512 * 1_024;

export type VisibleWorkspaceEntry = WorkspaceDirectoryEntryResource & Readonly<{ depth: number }>;

export function flattenDirectoryEntries(
  entriesByDirectory: Readonly<Record<string, readonly WorkspaceDirectoryEntryResource[]>>,
  expandedDirectories: ReadonlySet<string>,
  directory = "",
  depth = 0,
): readonly VisibleWorkspaceEntry[] {
  const visible: VisibleWorkspaceEntry[] = [];
  for (const entry of entriesByDirectory[directory] ?? []) {
    visible.push({ ...entry, depth });
    if (entry.kind === "directory" && expandedDirectories.has(entry.path)) {
      visible.push(
        ...flattenDirectoryEntries(entriesByDirectory, expandedDirectories, entry.path, depth + 1),
      );
    }
  }
  return visible;
}

function message(error: unknown, t: Translate): string {
  if (error instanceof PiCloudApiError) return error.message;
  if (error instanceof Error && error.message.trim().length > 0) {
    return t("inspector.readFailed", { message: error.message });
  }
  return t("inspector.unavailable");
}

export function canPreviewWorkspaceFile(file: WorkspaceDirectoryEntryResource): boolean {
  return (
    file.kind === "file" &&
    (file.sizeBytes ?? Number.POSITIVE_INFINITY) <= MAXIMUM_WORKSPACE_PREVIEW_BYTES
  );
}

function sizeLabel(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}

function decodedText(bytes: Uint8Array): string | null {
  if (bytes.some((byte) => byte === 0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function WorkspaceInspector({
  api,
  onClose,
  onError,
  refreshSignal,
  sessionId,
  workspaceId,
  workspaceName,
}: {
  api: PiCloudApi;
  onClose: () => void;
  onError: (message: string) => void;
  refreshSignal: number;
  sessionId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
}) {
  const { t } = useI18n();
  const [entriesByDirectory, setEntriesByDirectory] = useState<
    Readonly<Record<string, readonly WorkspaceDirectoryEntryResource[]>>
  >({});
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedFile, setSelectedFile] = useState<WorkspaceDirectoryEntryResource | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [selectedBinary, setSelectedBinary] = useState(false);
  const [selectedTooLarge, setSelectedTooLarge] = useState(false);
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [fileLoading, setFileLoading] = useState(false);
  const [view, setView] = useState<"files" | "terminal">("files");
  const [developmentEnvironmentId, setDevelopmentEnvironmentId] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  const loadGeneration = useRef(0);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (workspaceId === null) {
      setDevelopmentEnvironmentId(null);
      return;
    }
    let cancelled = false;
    void api
      .listDevelopmentEnvironments()
      .then((listed) => {
        if (cancelled) return;
        setDevelopmentEnvironmentId(
          listed.environments.find(
            (environment) =>
              environment.workspaceId === workspaceId && environment.state === "running",
          )?.environmentId ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setDevelopmentEnvironmentId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, refreshSignal, workspaceId]);

  const loadDirectory = useCallback(
    async (path: string, generation: number): Promise<void> => {
      if (sessionId === null) return;
      setLoadingDirectories((current) => new Set(current).add(path));
      try {
        const listed = await api.listWorkspaceDirectory(sessionId, path);
        if (generation !== loadGeneration.current) return;
        setEntriesByDirectory((current) => ({ ...current, [path]: listed.entries }));
        if (listed.truncated) onErrorRef.current(t("inspector.directoryTruncated"));
      } catch (error: unknown) {
        if (generation === loadGeneration.current) onErrorRef.current(message(error, t));
      } finally {
        if (generation === loadGeneration.current) {
          setLoadingDirectories((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        }
      }
    },
    [api, sessionId, t],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setEntriesByDirectory({});
    setExpandedDirectories(new Set());
    setSelectedFile(null);
    setSelectedText(null);
    setSelectedBinary(false);
    setSelectedTooLarge(false);
    setFileLoading(false);
    if (sessionId !== null) await loadDirectory("", generation);
  }, [loadDirectory, sessionId]);

  useEffect(() => {
    setView("files");
    void refresh();
    return () => {
      loadGeneration.current += 1;
    };
  }, [refresh, refreshSignal]);

  async function toggleDirectory(path: string): Promise<void> {
    if (expandedDirectories.has(path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpandedDirectories((current) => new Set(current).add(path));
    if (entriesByDirectory[path] === undefined) {
      await loadDirectory(path, loadGeneration.current);
    }
  }

  async function openFile(file: WorkspaceDirectoryEntryResource): Promise<void> {
    if (sessionId === null || file.kind !== "file") return;
    const generation = loadGeneration.current;
    const previewable = canPreviewWorkspaceFile(file);
    setSelectedFile(file);
    setSelectedText(null);
    setSelectedBinary(false);
    setSelectedTooLarge(!previewable);
    if (!previewable) return;
    setFileLoading(true);
    try {
      const result = await api.readWorkspaceFile(sessionId, file.path);
      if (generation !== loadGeneration.current) return;
      const text = decodedText(result.bytes);
      setSelectedText(text);
      setSelectedBinary(text === null);
    } catch (error: unknown) {
      if (generation === loadGeneration.current) onErrorRef.current(message(error, t));
    } finally {
      if (generation === loadGeneration.current) setFileLoading(false);
    }
  }

  const visibleEntries = useMemo(
    () => flattenDirectoryEntries(entriesByDirectory, expandedDirectories),
    [entriesByDirectory, expandedDirectories],
  );
  const rootLoading = loadingDirectories.has("");

  return (
    <aside className="workspace-directory" aria-label={t("common.workspace")}>
      <header className="workspace-directory-header">
        <div>
          <span>WORKSPACE</span>
          <strong>{workspaceName ?? "/workspace"}</strong>
          <small>{t("inspector.liveFiles")}</small>
        </div>
        <div>
          <button
            disabled={rootLoading}
            onClick={() => void refresh()}
            title={t("inspector.refresh")}
            type="button"
          >
            ↻
          </button>
          <button onClick={onClose} title={t("common.close")} type="button">
            ×
          </button>
        </div>
      </header>
      <div className="workspace-view-tabs" role="tablist" aria-label={t("inspector.views")}>
        <button
          aria-selected={view === "files"}
          className={view === "files" ? "active" : ""}
          onClick={() => setView("files")}
          role="tab"
          type="button"
        >
          {t("inspector.files")}
        </button>
        <button
          aria-selected={view === "terminal"}
          className={view === "terminal" ? "active" : ""}
          onClick={() => setView("terminal")}
          role="tab"
          type="button"
        >
          {t("inspector.terminal")}
        </button>
      </div>
      {view === "terminal" ? (
        <Suspense fallback={<div className="workspace-empty">{t("terminal.starting")}</div>}>
          <WorkspaceTerminal
            {...(developmentEnvironmentId === null
              ? { sessionId }
              : { environmentId: developmentEnvironmentId })}
            onError={onError}
          />
        </Suspense>
      ) : (
        <div className="workspace-directory-body">
          <nav className="workspace-file-tree" aria-label={t("inspector.fileTree")}>
            <div className="workspace-root-row">
              <strong>/workspace</strong>
            </div>
            {rootLoading ? (
              <div className="workspace-empty">{t("inspector.loadingDirectory")}</div>
            ) : visibleEntries.length === 0 ? (
              <div className="workspace-empty">{t("inspector.emptyDirectory")}</div>
            ) : (
              visibleEntries.map((entry) =>
                entry.kind === "directory" ? (
                  <button
                    aria-expanded={expandedDirectories.has(entry.path)}
                    className="workspace-tree-directory"
                    key={`directory:${entry.path}`}
                    onClick={() => void toggleDirectory(entry.path)}
                    style={{ paddingLeft: `${String(16 + entry.depth * 16)}px` }}
                    title={entry.path}
                    type="button"
                  >
                    <span>
                      {loadingDirectories.has(entry.path)
                        ? "…"
                        : expandedDirectories.has(entry.path)
                          ? "▾"
                          : "▸"}
                    </span>
                    <span>{entry.name}</span>
                  </button>
                ) : entry.kind === "symlink" ? (
                  <div
                    className="workspace-tree-file"
                    key={`symlink:${entry.path}`}
                    style={{ paddingLeft: `${String(18 + entry.depth * 16)}px` }}
                    title={entry.path}
                  >
                    <span>↗</span>
                    <span>{entry.name}</span>
                  </div>
                ) : (
                  <button
                    className={`workspace-tree-file${selectedFile?.path === entry.path ? " active" : ""}`}
                    key={`file:${entry.path}`}
                    onClick={() => void openFile(entry)}
                    style={{ paddingLeft: `${String(18 + entry.depth * 16)}px` }}
                    title={entry.path}
                    type="button"
                  >
                    <span>{entry.executable ? "◆" : "·"}</span>
                    <span>{entry.name}</span>
                    <small>{sizeLabel(entry.sizeBytes ?? 0)}</small>
                  </button>
                ),
              )
            )}
          </nav>
          <section className="workspace-file-preview">
            {selectedFile === null ? (
              <div className="workspace-preview-empty">
                <span>{t("inspector.selectFile")}</span>
                <small>{t("inspector.fileSource")}</small>
              </div>
            ) : (
              <>
                <header>
                  <strong>{selectedFile.path}</strong>
                  <span>{sizeLabel(selectedFile.sizeBytes ?? 0)}</span>
                </header>
                {fileLoading ? (
                  <div className="workspace-preview-empty">{t("inspector.loadingFile")}</div>
                ) : selectedTooLarge ? (
                  <div className="workspace-preview-empty">
                    <span>{t("inspector.largeFile")}</span>
                    <small>
                      {t("inspector.largeFileDetail", {
                        size: sizeLabel(MAXIMUM_WORKSPACE_PREVIEW_BYTES),
                      })}
                    </small>
                  </div>
                ) : selectedBinary ? (
                  <div className="workspace-preview-empty">{t("inspector.binaryFile")}</div>
                ) : (
                  <pre>
                    <code>{selectedText ?? ""}</code>
                  </pre>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
