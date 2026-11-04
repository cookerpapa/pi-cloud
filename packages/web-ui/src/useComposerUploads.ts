import { useEffect, useRef, useState } from "react";
import { uploadFileName, type UserUpload } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { characterCount } from "./pasted-text.ts";

export type ComposerUpload = {
  id: string;
  name: string;
  size: number;
  file?: File;
  upload?: UserUpload;
  source?: UserUpload | undefined;
  deferred?: boolean;
  characters?: number;
  status: "pending" | "uploading" | "ready" | "failed";
};

/** Queue editors have only a Session key; the main composer also knows its cwd. */
export function uploadMatchesWorkspace(upload: UserUpload, workspaceKey: string): boolean {
  const [session, workspace] = workspaceKey.split(":", 2);
  if (!workspace) return !session || upload.sessionId === session;
  const parts: string[] = [];
  for (const part of workspaceKey.slice(session!.length + workspace.length + 2).split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const directory = parts.length ? `/${parts.join("/")}` : "";
  return (
    upload.sessionId === session &&
    upload.workspaceId === workspace &&
    upload.path === `${directory}/uploads/${upload.id}/${upload.name}`
  );
}

/** Files remain local until a Session exists; each retry keeps the same upload identity. */
export function useComposerUploads(
  api: PiCloudApi,
  sessionId: string | undefined,
  workspaceKey: string,
) {
  const [items, setItems] = useState<ComposerUpload[]>([]);
  const [error, setError] = useState(false);
  const current = useRef(items);
  const tasks = useRef(new Map<string, { abort: AbortController; promise: Promise<UserUpload> }>());
  const serial = useRef<Promise<unknown>>(Promise.resolve());
  const scope = useRef(workspaceKey);
  const mounted = useRef(true);
  function replace(next: ComposerUpload[]) {
    current.current = next;
    if (mounted.current) setItems(next);
  }
  function clear(ids = current.current.map((item) => item.id)) {
    for (const id of ids) tasks.current.get(id)?.abort.abort();
    replace(current.current.filter((item) => !ids.includes(item.id)));
    if (mounted.current) setError(false);
  }
  function add(files: File[], options: { deferred?: boolean; characters?: number } = {}) {
    const next = files.map((file): ComposerUpload => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      file,
      status: "pending",
      ...options,
    }));
    try {
      for (const item of next) {
        uploadFileName(item.name);
        if (item.size < 1) throw new Error();
      }
      replace([...current.current, ...next]);
      setError(false);
    } catch {
      setError(true);
    }
  }
  function reuse(upload: UserUpload) {
    replace([
      ...current.current,
      {
        id: crypto.randomUUID(),
        name: upload.name,
        size: upload.byteLength,
        source: upload,
        status: "pending",
        deferred: true,
      },
    ]);
  }
  function edit(id: string, text: string) {
    const old = current.current.find((item) => item.id === id);
    if (!old) throw new Error("Attachment draft is no longer available");
    const file = new File([text], old.name, { type: "text/plain" });
    if (!file.size) throw new Error("Attachment cannot be empty");
    tasks.current.get(id)?.abort.abort();
    replace(
      current.current.map((item) =>
        item.id !== id
          ? item
          : {
              id: crypto.randomUUID(),
              name: file.name,
              size: file.size,
              file,
              status: "pending",
              deferred: true,
              ...(old.characters === undefined ? {} : { characters: characterCount(text) }),
            },
      ),
    );
    if (old.upload) void api.removeDraftUpload(old.upload).catch(() => undefined);
  }
  function restore(uploads: UserUpload[]) {
    const seen = new Set(
      current.current.flatMap((item) => [item.id, ...(item.source ? [item.source.id] : [])]),
    );
    const next = uploads.filter((upload) => {
      if (seen.has(upload.id)) return false;
      seen.add(upload.id);
      return true;
    });
    replace([
      ...current.current,
      ...next.map((upload): ComposerUpload =>
        uploadMatchesWorkspace(upload, workspaceKey)
          ? { id: upload.id, name: upload.name, size: upload.byteLength, upload, status: "ready" }
          : {
              id: crypto.randomUUID(),
              name: upload.name,
              size: upload.byteLength,
              source: upload,
              status: "pending",
              deferred: true,
            },
      ),
    ]);
    return true;
  }
  function restoreDrafts(drafts: readonly ComposerUpload[]) {
    const seen = new Set(current.current.map((item) => item.id));
    const next = drafts.filter((draft) => {
      if (seen.has(draft.id)) return false;
      seen.add(draft.id);
      return true;
    });
    replace([
      ...current.current,
      ...next.map((item): ComposerUpload =>
        item.upload && !uploadMatchesWorkspace(item.upload, workspaceKey)
          ? {
              id: crypto.randomUUID(),
              name: item.name,
              size: item.size,
              source: item.upload,
              status: "pending",
              deferred: true,
            }
          : {
              ...item,
              status: item.upload ? "ready" : "pending",
              deferred: true,
            },
      ),
    ]);
  }
  function uploadOne(item: ComposerUpload, target: string): Promise<UserUpload> {
    if (item.upload) {
      if (item.upload.sessionId !== target || !uploadMatchesWorkspace(item.upload, workspaceKey))
        return Promise.reject(new Error("Attachment belongs to another conversation or Workspace"));
      return Promise.resolve(item.upload);
    }
    const running = tasks.current.get(item.id);
    if (running) return running.promise;
    const abort = new AbortController();
    replace(
      current.current.map((value) =>
        value.id === item.id ? { ...value, status: "uploading" } : value,
      ),
    );
    const promise = serial.current
      .catch(() => undefined)
      .then(async () => {
        abort.signal.throwIfAborted();
        if (!item.file && !item.source) throw new Error("Attachment file is unavailable");
        const result = item.source
          ? await api.reuseInputAttachment(target, item.id, item.source, abort.signal)
          : await api.uploadWorkspaceFile(target, item.id, item.file!, item.name, abort.signal);
        abort.signal.throwIfAborted();
        replace(
          current.current.map((value) =>
            value.id === item.id ? { ...value, upload: result, status: "ready" } : value,
          ),
        );
        return result;
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          replace(
            current.current.map((value) =>
              value.id === item.id ? { ...value, status: "failed" } : value,
            ),
          );
        throw cause;
      })
      .finally(() => {
        tasks.current.delete(item.id);
      });
    tasks.current.set(item.id, { abort, promise });
    serial.current = promise.catch(() => undefined);
    return promise;
  }
  async function ready(target: string, ids?: readonly string[]): Promise<UserUpload[]> {
    const snapshot = ids
      ? ids.map((id) => {
          const item = current.current.find((value) => value.id === id);
          if (!item) throw new Error("The submitted attachment was removed");
          return item;
        })
      : [...current.current];
    const result: UserUpload[] = [];
    for (const item of snapshot) result.push(await uploadOne(item, target));
    return result;
  }
  useEffect(() => {
    if (scope.current && scope.current !== workspaceKey) {
      if (scope.current.split(":", 1)[0] !== workspaceKey.split(":", 1)[0]) clear();
      else {
        for (const task of tasks.current.values()) task.abort.abort();
        replace(
          current.current.map((item) => ({
            id: crypto.randomUUID(),
            name: item.name,
            size: item.size,
            ...(item.upload || item.source
              ? { source: item.upload ?? item.source }
              : item.file
                ? { file: item.file }
                : {}),
            status: "pending",
            deferred: true,
            ...(item.characters === undefined ? {} : { characters: item.characters }),
          })),
        );
      }
    }
    scope.current = workspaceKey;
    if (sessionId)
      for (const item of current.current)
        if (item.status === "pending" && !item.deferred)
          void uploadOne(item, sessionId).catch(() => undefined);
  }, [sessionId, workspaceKey, items]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const task of tasks.current.values()) task.abort.abort();
    };
  }, []);
  return {
    items,
    error,
    add,
    edit,
    reuse,
    restore,
    restoreDrafts,
    clear,
    ready,
    retry: (id: string) => {
      const item = current.current.find((value) => value.id === id);
      if (item && sessionId) void uploadOne(item, sessionId).catch(() => undefined);
    },
    remove: (id: string) => {
      const item = current.current.find((value) => value.id === id);
      clear([id]);
      if (item?.upload) void api.removeDraftUpload(item.upload).catch(() => undefined);
    },
  };
}
