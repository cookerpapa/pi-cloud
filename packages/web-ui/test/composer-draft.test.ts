import { afterEach, expect, it, vi } from "vitest";
import {
  composerDraftKey,
  readComposerDraft,
  saveComposerDraft,
  restoredComposerItems,
  storedComposerItems,
} from "../src/composer-draft.ts";
import type { ComposerUpload } from "../src/useComposerUploads.ts";

const memory = new Map<string, string>();
function storage() {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  memory.clear();
});
it("keeps file metadata and pending identity without caching a local binary", () => {
  storage();
  const key = composerDraftKey("tenant", "owner", "session");
  const file = new File(["not copied to browser storage"], "weights.bin");
  const item: ComposerUpload = {
    id: "upload-1",
    name: file.name,
    size: file.size,
    file,
    retention: "workspace",
    status: "uploading",
    started: true,
    progress: 5,
    sha256: "a".repeat(64),
    targetKey: "session:workspace:/workspace",
  };
  expect(
    saveComposerDraft(key, { text: "Run inference", items: storedComposerItems([item]) }),
  ).toBe(true);
  expect(memory.get(key)).not.toContain("not copied to browser storage");
  const saved = readComposerDraft(key)!;
  const restored = restoredComposerItems(saved.items)[0]!;
  expect(restored).toMatchObject({ id: "upload-1", status: "paused", progress: 5 });
  expect(restored.file).toBeUndefined();
  expect(saved.text).toBe("Run inference");
});
it("restores clipboard text without requiring a nonexistent disk file", async () => {
  storage();
  const text = "日志\r\n" + "字".repeat(5000);
  const item: ComposerUpload = {
    id: "paste",
    name: "pasted.txt",
    size: new Blob([text]).size,
    pastedText: text,
    characters: text.length,
    status: "pending",
    retention: "session",
  };
  saveComposerDraft("paste", { items: storedComposerItems([item]) });
  expect(await restoredComposerItems(readComposerDraft("paste")!.items)[0]!.file!.text()).toBe(
    text,
  );
});
it("scopes local data by account and conversation and merges newer fields", () => {
  storage();
  const key = composerDraftKey("tenant", "user-a", "session");
  saveComposerDraft(key, { text: "new text" });
  saveComposerDraft(key, { items: [] });
  expect(readComposerDraft(key)?.text).toBe("new text");
  expect(readComposerDraft(composerDraftKey("tenant", "user-b", "session"))).toBeUndefined();
  expect(readComposerDraft(composerDraftKey("tenant", "user-a", "other"))).toBeUndefined();
});
it("reports unavailable browser persistence without erasing an earlier draft", () => {
  storage();
  saveComposerDraft("draft", { text: "saved" });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key),
    setItem: () => {
      throw new Error("quota");
    },
  });
  expect(saveComposerDraft("draft", { text: "unsaved" })).toBe(false);
  expect(readComposerDraft("draft")?.text).toBe("saved");
});
