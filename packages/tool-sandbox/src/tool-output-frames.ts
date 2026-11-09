/** Bound final image frames and incomplete lines before parsing. Previews have
 * their own smaller protocol limit. This consumes only the fixed child output. */
export async function* toolOutputFrames(
  input: AsyncIterable<Uint8Array>,
  maximumBytes = 64 * 1024 * 1024,
): AsyncGenerator<string> {
  let chunks: Buffer[] = [],
    size = 0;
  for await (const chunk of input) {
    let bytes = Buffer.from(chunk);
    while (bytes.length) {
      const end = bytes.indexOf(10),
        part = end < 0 ? bytes : bytes.subarray(0, end);
      size += part.length;
      if (size > maximumBytes) throw new Error("Guest output frame exceeded its bound");
      chunks.push(part);
      if (end < 0) break;
      yield Buffer.concat(chunks, size).toString("utf8");
      chunks = [];
      size = 0;
      bytes = bytes.subarray(end + 1);
    }
  }
  if (size) throw new Error("Guest output ended in an incomplete frame");
}
