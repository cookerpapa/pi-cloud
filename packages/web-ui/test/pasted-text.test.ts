import { describe, expect, it } from "vitest";
import type { UserUpload } from "@pi-cloud/protocol";
import { uploadMatchesWorkspace } from "../src/useComposerUploads.ts";
import {
  characterCount,
  decodeAttachmentText,
  editableTextFile,
  longPasteFile,
} from "../src/pasted-text.ts";

describe("long paste originals", () => {
  it("prepares a new copy after changing Workspace or directory, but keeps the current placement", () => {
    const upload = {
      id: "upload",
      sessionId: "session",
      workspaceId: "volume",
      name: "log.txt",
      path: "/workspace/old/uploads/upload/log.txt",
    } as UserUpload;
    expect(uploadMatchesWorkspace(upload, "session:volume:/workspace/old")).toBe(true);
    expect(uploadMatchesWorkspace(upload, "session:volume:/workspace/old/./")).toBe(true);
    expect(uploadMatchesWorkspace(upload, "session:volume:/workspace/new")).toBe(false);
    expect(uploadMatchesWorkspace(upload, "session:fresh:/workspace/old")).toBe(false);
    expect(uploadMatchesWorkspace(upload, "session")).toBe(true);
  });
  it("uses Unicode characters rather than UTF-16 units at the threshold", () => {
    expect(longPasteFile("🚲".repeat(4000))).toBeUndefined();
    expect(longPasteFile("字".repeat(4000))).toBeUndefined();
    expect(longPasteFile("字".repeat(4001))?.characters).toBe(4001);
    expect(characterCount("A🚲中")).toBe(3);
  });
  it("keeps fifty thousand characters, CRLF, BOM and whitespace byte-for-byte", async () => {
    const text = "\ufeff  原始日志\r\n" + "日志🚲".repeat(17000) + "\r\n\t ";
    const attachment = longPasteFile(text)!;
    expect(attachment.file.type).toBe("text/plain");
    const bytes = new Uint8Array(await attachment.file.arrayBuffer());
    expect(bytes).toEqual(new TextEncoder().encode(text));
    expect(decodeAttachmentText(bytes)).toBe(text);
    expect(attachment.characters).toBe(characterCount(text));
  });
  it("does not silently convert invalid UTF-8 to replacement characters", () => {
    expect(() => decodeAttachmentText(Uint8Array.of(0xff))).toThrow();
    expect(editableTextFile("日志.txt")).toBe(true);
    expect(editableTextFile("photo.png", "image/png")).toBe(false);
  });
});
