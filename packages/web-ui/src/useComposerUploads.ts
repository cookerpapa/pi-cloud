import { useEffect, useRef, useState } from "react";
import { uploadFileName, type UserUpload } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";

export type ComposerUpload = {
  id: string;
  name: string;
  size: number;
  file?: File;
  upload?: UserUpload;
  status: "pending" | "uploading" | "ready" | "failed";
};

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
  function add(files: File[]) {
    const next = files.map((file): ComposerUpload => ({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      file,
      status: "pending",
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
  function restore(uploads: UserUpload[]) {
    const next = uploads.filter((upload) => !current.current.some((item) => item.id === upload.id));
    replace([
      ...current.current,
      ...next.map((upload): ComposerUpload => ({
        id: upload.id,
        name: upload.name,
        size: upload.byteLength,
        upload,
        status: "ready",
      })),
    ]);
    return true;
  }
  function uploadOne(item: ComposerUpload, target: string): Promise<UserUpload> {
    if (item.upload) {
      if (item.upload.sessionId !== target)
        return Promise.reject(new Error("Attachment belongs to another conversation"));
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
        if (!item.file) throw new Error("Attachment file is unavailable");
        const result = await api.uploadWorkspaceFile(
          target,
          item.id,
          item.file,
          item.name,
          abort.signal,
        );
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
  async function ready(target: string): Promise<UserUpload[]> {
    const snapshot = [...current.current];
    const result: UserUpload[] = [];
    for (const item of snapshot) result.push(await uploadOne(item, target));
    return result;
  }
  useEffect(() => {
    if (scope.current && scope.current !== workspaceKey) clear();
    scope.current = workspaceKey;
    if (sessionId)
      for (const item of current.current)
        if (item.status === "pending") void uploadOne(item, sessionId).catch(() => undefined);
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
    restore,
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
