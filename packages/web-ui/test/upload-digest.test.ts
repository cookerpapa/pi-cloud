import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { blobContentDigest } from "../src/upload-digest.ts";

it("hashes bounded browser slices with a standard digest and responds to cancellation", async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 123);
  const file = new Blob([bytes]);
  vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Must not buffer the entire file"));
  expect(await blobContentDigest(file)).toBe(
    `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`,
  );
  const abort = new AbortController();
  const slice = file.slice.bind(file);
  vi.spyOn(file, "slice").mockImplementation((...args) => {
    abort.abort(new Error("cancelled"));
    return slice(...args);
  });
  await expect(blobContentDigest(file, abort.signal)).rejects.toThrow("cancelled");
});
