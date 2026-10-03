import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { uploadContentDigest } from "@pi-cloud/protocol";

/** Bounded slices avoid a second whole-file allocation in the browser. */
export async function blobContentDigest(file: Blob, signal?: AbortSignal): Promise<string> {
  const hash = sha256.create();
  try {
    for (let offset = 0; offset < file.size; offset += 256 * 1024) {
      signal?.throwIfAborted();
      hash.update(new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer()));
    }
    signal?.throwIfAborted();
    return uploadContentDigest(bytesToHex(hash.digest()));
  } finally {
    hash.destroy();
  }
}
