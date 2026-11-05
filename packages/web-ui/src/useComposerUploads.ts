import { useEffect, useRef, useState } from "react";
import { uploadFileName, type UserUpload, type WorkspaceFileTransfer } from "@pi-cloud/protocol";
import { PiCloudApiError, type PiCloudApi } from "./api.ts";
import { characterCount } from "./pasted-text.ts";
import { blobSha256 } from "./upload-digest.ts";
import {
  readComposerDraft,
  saveComposerDraft,
  storedComposerItems,
  restoredComposerItems,
} from "./composer-draft.ts";

export type ComposerUpload = {
  id: string;
  name: string;
  size: number;
  file?: File;
  upload?: UserUpload;
  source?: UserUpload | undefined;
  deferred?: boolean;
  characters?: number;
  retention?: "session" | "workspace";
  transfer?: WorkspaceFileTransfer;
  sha256?: string;
  progress?: number;
  started?: boolean;
  targetKey?: string;
  directory?: string;
  pastedText?: string;
  failure?: string | undefined;
  status: "pending" | "uploading" | "ready" | "failed" | "paused";
};
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

/** Local drafts precede upload. A restored File descriptor is not access to its
 * bytes: only explicit source reselection may resume an incomplete local file. */
export function useComposerUploads(
  api: PiCloudApi,
  sessionId: string | undefined,
  workspaceKey: string,
  draftKey?: string,
) {
  const [items, setItems] = useState<ComposerUpload[]>([]);
  const [error, setError] = useState(false);
  const [persistenceError, setPersistenceError] = useState(false);
  const current = useRef(items);
  const tasks = useRef(
    new Map<string, { abort: AbortController; promise: Promise<UserUpload | undefined> }>(),
  );
  const serial = useRef<Promise<unknown>>(Promise.resolve());
  const scope = useRef({ workspaceKey, draftKey });
  const mounted = useRef(true);
  function replace(next: ComposerUpload[], persist = true) {
    current.current = next;
    if (mounted.current) setItems(next);
    if (
      persist &&
      scope.current.draftKey &&
      !saveComposerDraft(scope.current.draftKey, { items: storedComposerItems(next) })
    )
      if (mounted.current) setPersistenceError(true);
  }
  function change(id: string, patch: Partial<ComposerUpload>) {
    if (!mounted.current) return;
    replace(current.current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }
  function clear(ids = current.current.map((item) => item.id), persist = true) {
    for (const id of ids)
      tasks.current.get(id)?.abort.abort(new DOMException("Upload paused", "AbortError"));
    replace(
      current.current.filter((item) => !ids.includes(item.id)),
      persist,
    );
    if (mounted.current) setError(false);
  }
  function add(
    files: File[],
    options: {
      deferred?: boolean;
      characters?: number;
      retention?: "session" | "workspace";
      directory?: string;
      pastedText?: string;
    } = {},
  ) {
    try {
      const next = files.map((file): ComposerUpload => {
        uploadFileName(file.name);
        if (file.size < 1) throw new Error("Empty file");
        return {
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          file,
          retention: "session",
          deferred: true,
          status: "pending",
          ...options,
        };
      });
      replace([...current.current, ...next]);
      setError(false);
      // Clipboard-created files have no disk source to select after a reload.
      for (const item of next)
        if (item.characters !== undefined && item.pastedText === undefined)
          void item.file!.text().then((text) => change(item.id, { pastedText: text }));
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
        retention: "session",
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
    removeRemote(old);
    replace(
      current.current.map((item) =>
        item.id !== id
          ? item
          : {
              id: crypto.randomUUID(),
              name: file.name,
              size: file.size,
              file,
              retention: old.retention ?? "session",
              status: "pending",
              deferred: true,
              pastedText: text,
              ...(old.directory === undefined ? {} : { directory: old.directory }),
              ...(old.characters === undefined ? {} : { characters: characterCount(text) }),
            },
      ),
    );
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
          ? {
              id: upload.id,
              name: upload.name,
              size: upload.byteLength,
              upload,
              retention: "session",
              status: "ready",
            }
          : {
              id: crypto.randomUUID(),
              name: upload.name,
              size: upload.byteLength,
              source: upload,
              retention: "session",
              status: "pending",
              deferred: true,
            },
      ),
    ]);
    return true;
  }
  function restoreDrafts(drafts: readonly ComposerUpload[]) {
    const seen = new Set(current.current.map((item) => item.id));
    const next = drafts.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
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
              status: item.upload || item.transfer?.state === "ready" ? "ready" : "pending",
              deferred: true,
            },
      ),
    ]);
  }
  async function context(target: string) {
    const [selectedSession, workspace] = workspaceKey.split(":", 2);
    if (selectedSession === target && workspace)
      return {
        workspaceId: workspace,
        workingDirectory: workspaceKey.slice(target.length + workspace.length + 2),
      };
    const conversation = await api.getConversation(target);
    return {
      workspaceId: conversation.session.workspaceId,
      workingDirectory: conversation.session.workingDirectory,
    };
  }
  function uploadOne(item: ComposerUpload, target: string): Promise<UserUpload | undefined> {
    if (item.upload) {
      if (item.upload.sessionId !== target || !uploadMatchesWorkspace(item.upload, workspaceKey))
        return Promise.reject(new Error("Attachment belongs to another conversation or Workspace"));
      return Promise.resolve(item.upload);
    }
    const running = tasks.current.get(item.id);
    if (running) return running.promise;
    const abort = new AbortController();
    change(item.id, { status: "uploading", started: true, failure: undefined });
    const promise = serial.current
      .catch(() => undefined)
      .then(async () => {
        abort.signal.throwIfAborted();
        if (item.retention === "workspace") {
          const selected = await context(target);
          const key = `${target}:${selected.workspaceId}:${selected.workingDirectory}`;
          if (item.targetKey && item.targetKey !== key)
            throw new Error("Upload belongs to the previous Workspace or directory");
          change(item.id, { targetKey: key });
          if (item.transfer?.state === "ready") {
            if (
              item.transfer.workspaceId !== selected.workspaceId ||
              item.transfer.sessionId !== target
            )
              throw new Error("Workspace file belongs to another environment");
            change(item.id, { status: "ready" });
            return undefined;
          }
          if (!item.file) throw new Error("Select the original local file to continue uploading");
          const sha256 = await blobSha256(item.file, abort.signal);
          if (item.sha256 && item.sha256 !== sha256)
            throw new Error("Selected file differs from the original upload");
          change(item.id, { sha256 });
          const transfer = await api.createWorkspaceFileTransfer(
            target,
            item.id,
            {
              ...selected,
              name: item.name,
              byteLength: item.size,
              sha256,
              ...(item.directory === undefined ? {} : { directory: item.directory }),
            },
            abort.signal,
          );
          change(item.id, { transfer, progress: transfer.offset });
          let lastProgress = 0;
          const result = await api.continueWorkspaceFileTransfer(
            transfer,
            item.file,
            abort.signal,
            (progress) => {
              if (Date.now() - lastProgress < 200 && progress !== item.size) return;
              lastProgress = Date.now();
              change(item.id, { progress });
            },
          );
          abort.signal.throwIfAborted();
          change(item.id, { transfer: result, progress: result.offset, status: "ready" });
          return undefined;
        }
        if (!item.file && !item.source) throw new Error("Select the original local file to upload");
        const result = item.source
          ? await api.reuseInputAttachment(target, item.id, item.source, abort.signal)
          : await api.uploadWorkspaceFile(target, item.id, item.file!, item.name, abort.signal);
        abort.signal.throwIfAborted();
        change(item.id, { upload: result, status: "ready" });
        return result;
      })
      .catch((cause: unknown) => {
        change(item.id, {
          status: abort.signal.aborted ? "paused" : "failed",
          failure: cause instanceof Error ? cause.message : "Upload failed",
        });
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
    for (const item of snapshot) {
      const upload = await uploadOne(item, target);
      if (upload) result.push(upload);
    }
    return result;
  }
  function describe(text: string, ids?: readonly string[]) {
    const files = current.current
      .filter((item) => (!ids || ids.includes(item.id)) && item.retention === "workspace")
      .map((item) => {
        if (item.transfer?.state !== "ready") throw new Error("Workspace upload has not completed");
        return item.transfer;
      });
    if (!files.length) return text;
    return `${text}${text ? "\n\n" : ""}User-uploaded files (paths refer to the environment at upload time):\n${files
      .map((file, index) =>
        JSON.stringify({
          attachment: index + 1,
          name: file.name,
          path: file.path,
          mimeType: "application/octet-stream",
          bytes: file.byteLength,
        }),
      )
      .join("\n")}`;
  }
  function removeRemote(item: ComposerUpload) {
    const running = tasks.current.get(item.id);
    running?.abort.abort(new DOMException("Upload cancelled", "AbortError"));
    if (item.retention === "workspace" && item.started && sessionId)
      void (running?.promise.catch(() => undefined) ?? Promise.resolve())
        .then(() => api.cancelWorkspaceFileTransfer(sessionId, item.id))
        .catch(() => undefined);
    if (item.upload) void api.removeDraftUpload(item.upload).catch(() => undefined);
  }
  useEffect(() => {
    const previous = scope.current;
    if (previous.workspaceKey !== workspaceKey || previous.draftKey !== draftKey) {
      // A new conversation acquires its first Workspace while its initial file
      // preparation is already running. That is attachment, not a rebind.
      const firstAttachment = !previous.workspaceKey && !!workspaceKey && tasks.current.size > 0;
      if (previous.workspaceKey)
        for (const task of tasks.current.values())
          task.abort.abort(new DOMException("Workspace changed", "AbortError"));
      scope.current = { workspaceKey, draftKey };
      if (firstAttachment && previous.draftKey && draftKey) {
        const draft = readComposerDraft(previous.draftKey);
        if (
          saveComposerDraft(draftKey, {
            text: draft?.text ?? "",
            items: storedComposerItems(current.current),
            pending: draft?.pending ?? null,
          })
        )
          saveComposerDraft(previous.draftKey, { text: "", items: [], pending: null });
        else setPersistenceError(true);
        return;
      }
      const saved = draftKey ? readComposerDraft(draftKey) : undefined;
      if (saved) replace(restoredComposerItems(saved.items), false);
      else if (
        previous.workspaceKey &&
        previous.workspaceKey.split(":", 1)[0] !== workspaceKey.split(":", 1)[0]
      )
        replace([], false);
    }
    // Restore only descriptors; neither a mount nor a scope change starts bytes.
  }, [workspaceKey, draftKey]);
  useEffect(() => {
    mounted.current = true;
    if (draftKey) {
      const saved = readComposerDraft(draftKey);
      if (saved) replace(restoredComposerItems(saved.items), false);
    }
    return () => {
      mounted.current = false;
      for (const task of tasks.current.values())
        task.abort.abort(new DOMException("Page closed", "AbortError"));
    };
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    for (const item of current.current)
      if (item.retention === "workspace" && item.transfer && item.status !== "uploading") {
        void api
          .workspaceFileTransfer(sessionId, item.id, controller.signal)
          .then((transfer) => {
            if (!controller.signal.aborted)
              change(item.id, {
                transfer,
                progress: transfer.offset,
                status:
                  transfer.state === "ready"
                    ? "ready"
                    : transfer.state === "cancelled"
                      ? "failed"
                      : "paused",
                ...(transfer.state === "cancelled"
                  ? { failure: "Upload was cancelled; add the file again to start a new upload" }
                  : {}),
              });
          })
          .catch((cause) => {
            if (
              !controller.signal.aborted &&
              item.transfer?.state !== "ready" &&
              cause instanceof PiCloudApiError &&
              [404, 410].includes(cause.status)
            )
              change(item.id, {
                status: "failed",
                failure: "Upload expired or is unavailable; add the file again",
              });
          });
      }
    return () => controller.abort();
  }, [sessionId, workspaceKey, draftKey]);
  return {
    items,
    error,
    persistenceError,
    add,
    edit,
    reuse,
    restore,
    restoreDrafts,
    clear,
    ready,
    describe,
    detach: () => clear(undefined, false),
    snapshot: () => current.current,
    setRetention: (id: string, retention: "session" | "workspace") => {
      const item = current.current.find((value) => value.id === id);
      if (item && !item.started && !item.upload && !item.source && item.characters === undefined)
        change(id, { retention });
    },
    reselect: (id: string, file: File) => {
      const item = current.current.find((value) => value.id === id);
      if (!item) return;
      if (file.name !== item.name || file.size !== item.size) {
        change(id, {
          failure: "Select the original file with the same name and size",
          status: "failed",
        });
        return;
      }
      change(id, { file, status: "pending", failure: undefined });
    },
    pause: (id: string) => {
      tasks.current.get(id)?.abort.abort(new DOMException("Upload paused", "AbortError"));
    },
    retry: (id: string) => {
      const item = current.current.find((value) => value.id === id);
      if (item && sessionId) void uploadOne(item, sessionId).catch(() => undefined);
    },
    remove: (id: string) => {
      const item = current.current.find((value) => value.id === id);
      if (item) removeRemote(item);
      clear([id]);
    },
  };
}
