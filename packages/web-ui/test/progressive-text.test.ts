import { describe, expect, it } from "vitest";
import { initialProgressiveText, nextProgressiveTextIndex } from "../src/ConversationTurn.tsx";

describe("progressive durable text presentation", () => {
  it("reveals a durable batch through many small animation frames", () => {
    const text = "这是一段已经由 Kafka 确认、但需要在浏览器中平滑展示的中文文本。".repeat(80);
    let index = 0;
    const frames: number[] = [];
    while (index < text.length) {
      const next = nextProgressiveTextIndex(text, index);
      expect(next).toBeGreaterThan(index);
      expect(next - index).toBeLessThanOrEqual(36);
      frames.push(next);
      index = next;
    }
    expect(frames.length).toBeGreaterThan(100);
    expect(frames.at(-1)).toBe(text.length);
  });

  it("keeps a small live delta paced instead of flushing it in one frame", () => {
    const text = "一段刚刚抵达浏览器的流式文本";
    const first = nextProgressiveTextIndex(text, 0);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(text.length);
    expect(first).toBeLessThanOrEqual(8);
  });

  it("does not split a surrogate pair while choosing the next frame boundary", () => {
    const text = `${"a".repeat(10)}😀${"b".repeat(40)}`;
    let index = 0;
    while (index < text.length) {
      index = nextProgressiveTextIndex(text, index);
      const previous = text.charCodeAt(index - 1);
      const next = text.charCodeAt(index);
      expect(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff).toBe(
        false,
      );
    }
  });

  it("rejects presentation cursors outside the acknowledged text", () => {
    expect(() => nextProgressiveTextIndex("durable", -1)).toThrow(/index/u);
    expect(() => nextProgressiveTextIndex("durable", 8)).toThrow(/index/u);
  });

  it("uses the recovered Snapshot prefix as the initial visible baseline", () => {
    const recovered = "already durable";
    const target = `${recovered} and newly streamed`;
    expect(initialProgressiveText(target, true, recovered.length)).toBe(recovered);
    expect(initialProgressiveText(target, true)).toBe("");
    expect(initialProgressiveText(target, false)).toBe(target);
    expect(() => initialProgressiveText(target, true, -1)).toThrow(/Recovered/u);
  });
});
