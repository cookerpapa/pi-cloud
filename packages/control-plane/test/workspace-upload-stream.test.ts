import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { verifiedUpload, sniffUpload, forkUpload } from "../src/workspace-upload-stream.ts";

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const values: Buffer[] = [];
  for await (const chunk of chunks) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}
it("sniffs split signatures without losing bytes and verifies both backpressured destinations", async () => {
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
  const fork = forkUpload(sniffed.chunks, abort.signal);
  try {
    expect(await Promise.all([collect(fork.workspace), collect(fork.image)])).toEqual([
      bytes,
      bytes,
    ]);
  } finally {
    fork.close();
  }
});
it("aborts a demanded stalled chunk and rejects corruption on both destinations", async () => {
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
  const bad = forkUpload(
    verifiedUpload(
      {
        byteLength: 20,
        sha256: "a".repeat(64),
        chunks: (async function* () {
          yield Buffer.alloc(20);
        })(),
      },
      abort.signal,
    ),
    abort.signal,
  );
  try {
    const results = await Promise.allSettled([collect(bad.workspace), collect(bad.image)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  } finally {
    bad.close();
  }
});
