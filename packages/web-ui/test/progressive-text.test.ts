import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { initialProgressiveText, nextProgressiveTextIndex } from "../src/ConversationTurn.tsx";
import { Markdown, streamingMarkdownBlocks } from "../src/Markdown.tsx";

describe("progressive durable text presentation", () => {
  it.each([
    "Intro\n\n1. First\n\n2. Second\n\n3. Third\n\nEnd",
    "Intro\n\n- Item\n\n  Continued paragraph\n\n- Second item",
    "Intro\n\n````md\nCode starts\n```\n\nStill code\n````\n\nTail",
    "Intro\n\n    indented code\n\n    more code\n\nEnd",
    "One\n\nTwo [ref][r]\n\nThree\n\n[r]: https://example.test",
    "One\n\n> quoted\n\n> second\n\nEnd",
  ])("keeps incremental parsing equivalent at every prefix of %j", (text) => {
    const render = (parts: readonly string[]) =>
      parts
        .map((children) =>
          renderToStaticMarkup(
            createElement(ReactMarkdown, { children, remarkPlugins: [remarkGfm] }),
          ),
        )
        .join("")
        .replace(/>\n+</g, "><");
    let previous = { text: "", blocks: [] as readonly string[] };
    for (let end = 1; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      const blocks = streamingMarkdownBlocks(prefix, previous);
      expect(blocks.join("")).toBe(prefix);
      expect(render(blocks), `prefix ${end}: ${prefix}`).toBe(render([prefix]));
      previous = { text: prefix, blocks };
    }
  });
  it.each([
    "1. First\n\n2. Second\n\n3. Third",
    "- Item\n\n  Continued paragraph\n\n- Second item",
    "````md\nCode starts\n```\n\nStill code\n````\n\nTail",
    "Intro\n\n    indented code\n\n    more code",
    "Heading\n=======\n\nParagraph [link][r]\n\n[r]: https://example.test",
  ])("preserves complete Markdown semantics while streaming %j", (text) => {
    const render = (streaming: boolean) =>
      renderToStaticMarkup(createElement(Markdown, { streaming, children: text }));
    expect(render(true).replace(/>\n+</g, "><")).toBe(render(false).replace(/>\n+</g, "><"));
  });
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

  it("freezes completed Markdown blocks while a citation-heavy tail keeps growing", () => {
    expect(
      streamingMarkdownBlocks(
        "第一段已经稳定。\n\n第二段正在生成 [OpenAI](https://developers.openai.com",
      ),
    ).toEqual(["第一段已经稳定。\n\n", "第二段正在生成 [OpenAI](https://developers.openai.com"]);
  });

  it("does not split fenced code at blank lines", () => {
    expect(streamingMarkdownBlocks("```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n尾部")).toEqual([
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
      "尾部",
    ]);
  });
});
