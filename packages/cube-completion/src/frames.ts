import type { Readable } from "node:stream";

/** Bound incomplete frames before decoding, including a sender without newlines. */
export async function* completionFrames(
  input: Readable,
  maximumBytes = 65 * 1024 * 1024,
): AsyncGenerator<string> {
  let chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    let bytes = Buffer.from(chunk);
    while (bytes.length) {
      const end = bytes.indexOf(10);
      const part = end < 0 ? bytes : bytes.subarray(0, end);
      size += part.length;
      if (size > maximumBytes) throw new Error("Completion frame too large");
      chunks.push(part);
      if (end < 0) break;
      yield Buffer.concat(chunks, size).toString("utf8");
      chunks = [];
      size = 0;
      bytes = bytes.subarray(end + 1);
    }
  }
  if (size) throw new Error("Incomplete completion frame");
}
