import { expect, it, vi } from "vitest";
import { ToolPreviewBuffer, previewBytes, type ToolPreviewUpdate } from "@pi-cloud/protocol";
import { TerminalToolPreview } from "../src/tool-preview.ts";

it.each([
  ["carriage return", ["progress 10%\r", "progress 20%\r", "progress 30%"], "progress 30%"],
  ["shorter label", ["progress 100%", "\r\x1b[2Kdone"], "done"],
  ["split ANSI", ["old", "\x1b[", "2K\rnew"], "new"],
  ["multi-line", ["first\r\nsecond", "\x1b[1A\r\x1b[2Kchanged"], "changed\nsecond"],
  ["unicode", ["中文🙂\r", "\x1b[2K完成"], "完成"],
  ["backspace", ["ab\bc"], "ac"],
  ["CRLF", ["one\r", "\ntwo"], "one\ntwo"],
] as const)("interprets %s without leaking terminal controls", async (_name, chunks, expected) => {
  const updates: ToolPreviewUpdate[] = [],
    view = new ToolPreviewBuffer();
  const preview = new TerminalToolPreview((update) => {
    updates.push(update);
    view.accept(update);
  });
  try {
    for (const chunk of chunks) preview.append(chunk);
    await vi.waitFor(() => expect(preview.pendingBytes).toBe(0));
    preview.flush();
    expect(view.current?.text).toBe(expected);
    expect(updates).toHaveLength(1);
    expect(previewBytes(JSON.stringify(updates[0]))).toBeLessThan(65536);
  } finally {
    preview.close();
  }
});

it("sends a small edit and periodically resets even when a command becomes quiet", async () => {
  const updates: ToolPreviewUpdate[] = [],
    view = new ToolPreviewBuffer();
  const preview = new TerminalToolPreview((u) => {
    updates.push(u);
    view.accept(u);
  });
  try {
    const now = Date.now();
    preview.append("line\n".repeat(100));
    await vi.waitFor(() => expect(preview.pendingBytes).toBe(0));
    preview.flush(now);
    preview.append("new text");
    await vi.waitFor(() => expect(preview.pendingBytes).toBe(0));
    preview.flush(now + 1001);
    expect(updates[1]?.kind).toBe("delta");
    expect(previewBytes(JSON.stringify(updates[1]))).toBeLessThan(150);
    expect(view.current?.text.endsWith("new text")).toBe(true);
    preview.flush(now + 6000);
    expect(updates[2]?.kind).toBe("reset");
    preview.close();
    preview.flush(now + 12000);
    expect(updates).toHaveLength(3);
  } finally {
    preview.close();
  }
});

it("redacts before publication and never exports more than the preview byte window", async () => {
  const view = new ToolPreviewBuffer(),
    preview = new TerminalToolPreview((u) => view.accept(u));
  try {
    preview.append("text\n".repeat(3000) + "\nhttps://user:secret@example.test/path");
    await vi.waitFor(() => expect(preview.pendingBytes).toBe(0));
    preview.flush();
    expect(view.current?.text).not.toContain("secret");
    expect(view.current?.text).toContain("PI_CLOUD_REDACTED");
    expect(previewBytes(view.current!.text)).toBeLessThanOrEqual(8192);
  } finally {
    preview.close();
  }
});

it("does not resend an unchanged screen between recovery snapshots", async () => {
  const updates: ToolPreviewUpdate[] = [],
    preview = new TerminalToolPreview((u) => updates.push(u));
  try {
    const now = Date.now();
    preview.append("same");
    await vi.waitFor(() => expect(preview.pendingBytes).toBe(0));
    preview.flush(now);
    preview.append("\rsame");
    await vi.waitFor(() => expect(preview.pendingBytes).toBe(0));
    preview.flush(now + 1001);
    expect(updates).toHaveLength(1);
    preview.flush(now + 5001);
    expect(updates).toHaveLength(2);
  } finally {
    preview.close();
  }
});

it("retires overloaded or failed observers without throwing into command output collection", () => {
  const view = new ToolPreviewBuffer(),
    preview = new TerminalToolPreview((u) => view.accept(u));
  expect(() => preview.append("x".repeat(300000))).not.toThrow();
  preview.flush();
  expect(preview.unavailable).toBe(true);
  expect(preview.pendingBytes).toBe(0);
  expect(view.current?.unavailable).toBe(true);
  preview.close();
  const broken = new TerminalToolPreview(() => {
    throw new Error("observer disconnected");
  });
  broken.append("x".repeat(300000));
  expect(() => broken.flush()).not.toThrow();
  expect(broken.pendingBytes).toBe(0);
  broken.close();
});
