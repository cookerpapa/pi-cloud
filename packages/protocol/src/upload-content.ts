/** Wire-neutral byte source; bytes stay out of commands, queue rows and history. */
export type UploadContent = {
  chunks: AsyncIterable<Uint8Array>;
  byteLength: number;
  sha256: string;
};

export function uploadContentDigest(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid upload digest");
  const binary = sha256
    .match(/../g)!
    .map((pair) => String.fromCharCode(Number.parseInt(pair, 16)))
    .join("");
  return `sha-256=:${btoa(binary)}:`;
}
export function parseUploadIdentity(
  length: unknown,
  digest: unknown,
): Pick<UploadContent, "byteLength" | "sha256"> {
  if (typeof length !== "string" || !/^[1-9][0-9]*$/.test(length))
    throw new Error("Upload requires a positive Content-Length");
  const byteLength = Number(length);
  if (!Number.isSafeInteger(byteLength))
    throw new Error("Upload length cannot be represented exactly");
  const match = typeof digest === "string" ? /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(digest) : null;
  if (!match) throw new Error("Upload requires a SHA-256 Content-Digest");
  const binary = atob(match[1]!);
  if (binary.length !== 32 || btoa(binary) !== match[1]) throw new Error("Invalid upload digest");
  return {
    byteLength,
    sha256: [...binary].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
  };
}
