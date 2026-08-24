import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DevelopmentEnvironmentDirectoryEntry,
  DevelopmentEnvironmentDirectoryResource,
} from "@pi-cloud/protocol";
import { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";

function parent(path: string): string {
  if (path === "/") return "/";
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function childPath(path: string, name: string): string {
  return `${path === "/" ? "" : path}/${name}`;
}

function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function EntryIcon({ kind }: { kind: DevelopmentEnvironmentDirectoryEntry["kind"] }) {
  if (kind === "directory") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3.5 6.8a2 2 0 0 1 2-2h4l1.8 2h7.2a2 2 0 0 1 2 2v8.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 3.5h7l5 5v12H6Z" />
      <path d="M13 3.5v5h5" />
      {kind === "symlink" ? <path d="m9 16 6-6m-3 0h3v3" /> : null}
    </svg>
  );
}

function PlaceIcon({ children }: { children: ReactNode }) {
  return <span className="product-directory-place-icon">{children}</span>;
}

function entryType(
  entry: DevelopmentEnvironmentDirectoryEntry,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (entry.kind === "directory") return t("directory.type.folder");
  if (entry.kind === "file") return t("directory.type.file");
  if (entry.kind === "symlink") return t("directory.type.symlink");
  return t("directory.type.other");
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
  const { t } = useI18n();
  const [directory, setDirectory] = useState(initialDirectory);
  const [selectedDirectory, setSelectedDirectory] = useState(initialDirectory);
  const [listing, setListing] = useState<DevelopmentEnvironmentDirectoryResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const newFolderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNewFolderOpen(false);
    setNewFolderName("");
    void api
      .listDevelopmentEnvironmentDirectory(environmentId, directory)
      .then((resource) => {
        if (cancelled) return;
        setListing(resource);
        setSelectedDirectory(resource.path);
        if (resource.path !== directory) setDirectory(resource.path);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setListing(null);
          setError(reason instanceof Error ? reason.message : t("directory.error"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, directory, environmentId, t]);

  useEffect(() => {
    if (newFolderOpen) newFolderInput.current?.focus();
  }, [newFolderOpen]);

  const parts = useMemo(
    () => (directory === "/" ? [] : directory.slice(1).split("/")),
    [directory],
  );

  async function createDirectory(): Promise<void> {
    const name = newFolderName.trim();
    if (name.length === 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const resource = await api.createDevelopmentEnvironmentDirectory(
        environmentId,
        directory,
        name,
      );
      setListing(resource);
      setDirectory(resource.path);
      setSelectedDirectory(childPath(resource.path, name));
      setNewFolderOpen(false);
      setNewFolderName("");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : t("directory.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  const places = [
    { path: "/home/user", label: t("directory.home"), icon: "⌂" },
    { path: "/workspace", label: "Workspace", icon: "▣" },
    { path: "/", label: t("directory.computer"), icon: "▤" },
  ] as const;

  return (
    <div className="product-modal-backdrop product-directory-picker-backdrop" role="presentation">
      <section className="product-directory-picker" role="dialog" aria-modal="true">
        <header className="product-directory-titlebar">
          <div>
            <EntryIcon kind="directory" />
            <span>
              <h2>{t("directory.title")}</h2>
              <small>{workspaceName}</small>
            </span>
          </div>
          <button aria-label={t("common.close")} onClick={onCancel} type="button">
            ×
          </button>
        </header>

        <div className="product-directory-toolbar">
          <button
            aria-label={t("directory.up")}
            disabled={directory === "/" || loading}
            onClick={() => setDirectory(parent(directory))}
            title={t("directory.up")}
            type="button"
          >
            ←
          </button>
          <nav className="product-directory-address" aria-label={t("directory.location")}>
            <button onClick={() => setDirectory("/")} type="button">
              /
            </button>
            {parts.map((part, index) => {
              const target = `/${parts.slice(0, index + 1).join("/")}`;
              return (
                <button key={target} onClick={() => setDirectory(target)} type="button">
                  <span aria-hidden="true">›</span>
                  {part}
                </button>
              );
            })}
          </nav>
          <button
            className="product-directory-new-folder"
            disabled={loading || creating}
            onClick={() => setNewFolderOpen((open) => !open)}
            type="button"
          >
            <span aria-hidden="true">＋</span>
            {t("directory.newFolder")}
          </button>
        </div>

        {newFolderOpen ? (
          <form
            className="product-directory-create"
            onSubmit={(event) => {
              event.preventDefault();
              void createDirectory();
            }}
          >
            <EntryIcon kind="directory" />
            <input
              maxLength={255}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder={t("directory.newFolderPlaceholder")}
              ref={newFolderInput}
              value={newFolderName}
            />
            <button onClick={() => setNewFolderOpen(false)} type="button">
              {t("common.cancel")}
            </button>
            <button className="product-primary-button" disabled={creating || !newFolderName.trim()}>
              {creating ? t("directory.creating") : t("directory.create")}
            </button>
          </form>
        ) : null}

        <div className="product-directory-explorer">
          <aside className="product-directory-places">
            <strong>{t("directory.places")}</strong>
            {places.map((place) => (
              <button
                className={directory === place.path ? "active" : ""}
                key={place.path}
                onClick={() => setDirectory(place.path)}
                type="button"
              >
                <PlaceIcon>{place.icon}</PlaceIcon>
                <span>{place.label}</span>
              </button>
            ))}
          </aside>

          <div className="product-directory-main">
            <div className="product-directory-columns" aria-hidden="true">
              <span>{t("directory.column.name")}</span>
              <span>{t("directory.column.size")}</span>
              <span>{t("directory.column.type")}</span>
            </div>
            <div className="product-directory-browser" role="listbox">
              {loading ? (
                <span className="product-directory-loading">{t("directory.loading")}</span>
              ) : null}
              {error === null ? null : <span className="product-form-error">{error}</span>}
              {!loading && error === null && listing?.entries.length === 0 ? (
                <span className="product-empty-directory">{t("directory.empty")}</span>
              ) : null}
              {listing?.entries.map((entry) => {
                const selectable = entry.kind === "directory";
                return (
                  <button
                    aria-disabled={!selectable}
                    aria-selected={selectedDirectory === entry.path}
                    className={`product-directory-entry product-directory-entry-${entry.kind}${
                      selectedDirectory === entry.path ? " selected" : ""
                    }`}
                    key={entry.path}
                    onClick={() => {
                      if (selectable) setSelectedDirectory(entry.path);
                    }}
                    onDoubleClick={() => {
                      if (selectable) setDirectory(entry.path);
                    }}
                    onKeyDown={(event) => {
                      if (selectable && event.key === "Enter") setDirectory(entry.path);
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="product-directory-entry-name">
                      <EntryIcon kind={entry.kind} />
                      <strong>{entry.name}</strong>
                    </span>
                    <span>{entry.kind === "file" ? sizeLabel(entry.sizeBytes) : "—"}</span>
                    <span>{entryType(entry, t)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="product-directory-selection">
          <span>{t("directory.current", { directory: selectedDirectory })}</span>
          <code>{selectedDirectory}</code>
        </div>
        <footer>
          <button onClick={onCancel} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="product-primary-button"
            disabled={loading || creating || selectedDirectory.length === 0}
            onClick={() => onChoose(selectedDirectory)}
            type="button"
          >
            {t("directory.choose")}
          </button>
        </footer>
      </section>
    </div>
  );
}
