import type { UserUpload } from "@pi-cloud/protocol";
import type { ComposerInput } from "./composer-submission.ts";
import type { ComposerUpload } from "./useComposerUploads.ts";

export type PendingComposerDraft = {
  key: string;
  input: ComposerInput;
  attached: UserUpload[];
  draftText: string;
  draftIds: string[];
};
export type ComposerDraft = {
  version: 1;
  text: string;
  items: Omit<ComposerUpload, "file">[];
  pending: PendingComposerDraft | null;
};
export function composerDraftKey(tenant: string, user: string, session: string) {
  return `picloud.composer-draft.v1:${tenant}:${user}:${session}`;
}
export function readComposerDraft(key: string): ComposerDraft | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as ComposerDraft | null;
    if (
      !value ||
      value.version !== 1 ||
      typeof value.text !== "string" ||
      !Array.isArray(value.items) ||
      value.items.some(
        (item) =>
          !item ||
          typeof item.id !== "string" ||
          typeof item.name !== "string" ||
          !Number.isSafeInteger(item.size),
      )
    )
      return;
    if (
      value.pending &&
      (typeof value.pending.key !== "string" ||
        typeof value.pending.input?.text !== "string" ||
        !Array.isArray(value.pending.draftIds) ||
        !Array.isArray(value.pending.attached))
    )
      return;
    return value;
  } catch {
    return;
  }
}
export function saveComposerDraft(
  key: string,
  patch: Partial<Omit<ComposerDraft, "version">>,
): boolean {
  try {
    const previous = readComposerDraft(key) ?? {
      version: 1 as const,
      text: "",
      items: [],
      pending: null,
    };
    const next = { ...previous, ...patch, version: 1 };
    if (!next.text && !next.items.length && !next.pending) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
export function storedComposerItems(items: readonly ComposerUpload[]): ComposerDraft["items"] {
  return items.map(({ file: _file, ...item }) => ({
    ...item,
    status: item.status === "uploading" ? "paused" : item.status,
  }));
}
export function restoredComposerItems(items: ComposerDraft["items"]): ComposerUpload[] {
  return items.map((item) => ({
    ...item,
    ...(item.pastedText === undefined
      ? {}
      : { file: new File([item.pastedText], item.name, { type: "text/plain" }) }),
    status:
      item.upload || item.transfer?.state === "ready"
        ? "ready"
        : item.status === "uploading"
          ? "paused"
          : item.status,
    deferred: true,
  }));
}
