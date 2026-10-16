import { expect, it } from "vitest";
import {
  boundedPreviewText,
  previewBytes,
  previewUpdate,
  ToolPreviewBuffer,
  ToolPreviewChannel,
  parseToolPreviewUpdate,
  type ToolPreviewState,
} from "../src/tool-preview.ts";

it("round-trips append, head trim, terminal overwrite and Unicode without copying the old window", () => {
  const buffer = new ToolPreviewBuffer();
  let previous: ToolPreviewState | undefined;
  const texts = [
    "prefix".repeat(1000),
    "prefix".repeat(1000) + "新增🙂",
    "prefix".repeat(950) + "新增🙂tail",
    "progress 20%",
    "progress 30%",
    "done",
  ];
  for (const [i, text] of texts.entries()) {
    const next = { revision: i + 1, text: boundedPreviewText(text) };
    const change = previewUpdate(previous, next);
    buffer.accept(change);
    expect(buffer.current).toEqual(next);
    if (i === 1) {
      expect(change.kind).toBe("delta");
      expect(previewBytes(JSON.stringify(change))).toBeLessThan(160);
    }
    previous = next;
  }
});

it("never applies a delta across a gap, and ignores stale resets after the gap", () => {
  const view = new ToolPreviewBuffer();
  view.accept({ kind: "reset", revision: 1, text: "hello" });
  view.accept({
    kind: "delta",
    baseRevision: 2,
    revision: 3,
    dropHead: 0,
    keepPrefix: 5,
    text: "!",
  });
  expect(view.current).toBeUndefined();
  expect(view.accept({ kind: "reset", revision: 2, text: "stale" })).toBe(false);
  view.accept({ kind: "reset", revision: 4, text: "restored" });
  expect(view.current?.text).toBe("restored");
});

it("coalesces multiple unsent deltas and retains a source reset across following updates", () => {
  const channel = new ToolPreviewChannel(),
    receiver = new ToolPreviewBuffer();
  let previous = { revision: 1, text: "x".repeat(2000) };
  channel.accept({ kind: "reset", ...previous });
  receiver.accept(channel.take()!);
  for (let i = 2; i < 30; i++) {
    const next = { revision: i, text: previous.text + i };
    channel.accept(previewUpdate(previous, next, i === 10));
    previous = next;
  }
  const update = channel.take()!;
  expect(update.kind).toBe("reset");
  receiver.accept(update);
  expect(receiver.current).toEqual(previous);
  expect(channel.take()).toBeUndefined();
});

it("bounds UTF-8 text and refuses bad deltas or old snapshot-only messages", () => {
  const text = boundedPreviewText("中文🙂".repeat(3000));
  expect(previewBytes(text)).toBeLessThanOrEqual(8192);
  expect(text).not.toContain("�");
  expect(() => parseToolPreviewUpdate({ revision: 1, text })).toThrow();
  expect(() =>
    parseToolPreviewUpdate({ kind: "reset", revision: 1, text: "中".repeat(8192) }),
  ).toThrow();
  expect(() =>
    parseToolPreviewUpdate({
      kind: "delta",
      revision: 2,
      baseRevision: 2,
      dropHead: 0,
      keepPrefix: 0,
      text: "bad",
    }),
  ).toThrow();
});

it("round-trips bounded arbitrary edits including repeated prefixes and surrogate pairs", () => {
  const view = new ToolPreviewBuffer();
  let previous: ToolPreviewState | undefined;
  let seed = 12345;
  const rand = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  let points: string[] = [];
  for (let revision = 1; revision <= 800; revision++) {
    points.splice(rand(points.length + 1), rand(12), ...Array.from("a🙂中文".repeat(rand(30))));
    if (points.length > 2000) points.splice(0, 500);
    const next = { revision, text: boundedPreviewText(points.join("")) };
    view.accept(previewUpdate(previous, next));
    expect(view.current).toEqual(next);
    previous = next;
  }
});
