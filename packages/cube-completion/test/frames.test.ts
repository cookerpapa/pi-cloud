import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { completionFrames } from "../src/frames.ts";

it("decodes split UTF-8 and multiple frames without merging results", async () => {
  const bytes = Buffer.from('{"text":"图片"}\n{}\n');
  const output = [];
  for await (const line of completionFrames(
    Readable.from([bytes.subarray(0, 11), bytes.subarray(11)]),
  ))
    output.push(JSON.parse(line));
  expect(output).toEqual([{ text: "图片" }, {}]);
});
it("rejects an oversized unfinished frame before waiting for a delimiter", async () => {
  const frames = completionFrames(Readable.from([Buffer.alloc(9)]), 8);
  await expect(frames.next()).rejects.toThrow("too large");
});
it("does not accept a truncated final frame", async () => {
  const frames = completionFrames(Readable.from([Buffer.from("{}")]));
  await expect(frames.next()).rejects.toThrow("Incomplete");
});
