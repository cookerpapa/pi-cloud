import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { verifiedUpload, sniffUpload } from "../src/workspace-upload-stream.ts";

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const values: Buffer[] = [];
  for await (const chunk of chunks) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}
it("sniffs split signatures without losing original bytes", async () => {
  const bytes = Buffer.from("some image signature and its body");
  const abort = new AbortController();
  const source = verifiedUpload(
    {
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      chunks: (async function* () {
        for (const byte of bytes) yield Uint8Array.of(byte);
      })(),
    },
    abort.signal,
  );
  const sniffed = await sniffUpload(source);
  expect(sniffed.prefix).toEqual(bytes.subarray(0, 12));
  expect(await collect(sniffed.chunks)).toEqual(bytes);
  await sniffed.close();
});
it("aborts a demanded stalled chunk and rejects corrupted original bytes", async () => {
  const abort = new AbortController();
  const stalled = verifiedUpload(
    {
      byteLength: 1,
      sha256: "a".repeat(64),
      chunks: {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) };
        },
      },
    },
    abort.signal,
    20,
  );
  await expect(stalled.next()).rejects.toThrow("stopped making progress");
  const bad = verifiedUpload(
    {
      byteLength: 20,
      sha256: "a".repeat(64),
      chunks: (async function* () {
        yield Buffer.alloc(20);
      })(),
    },
    abort.signal,
  );
  await expect(collect(bad)).rejects.toThrow("digest");
});
