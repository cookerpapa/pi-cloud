import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CAPSULE_PREFIX = "pcvm1_";
const AAD = Buffer.from("pi-cloud:cube-persistent-machine:v1", "utf8");

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Persistent machine capsule was invalid");
  return Buffer.from(value, "base64url");
}

export class CubePersistentCapsuleCodec {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new TypeError("Cube persistent-state key must be 32 bytes");
    this.#key = Buffer.from(key);
  }

  seal(value: unknown): string {
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    if (plaintext.byteLength < 2 || plaintext.byteLength > 96 * 1_024) {
      throw new Error("Persistent machine state exceeded its byte boundary");
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: 16 });
    cipher.setAAD(AAD, { plaintextLength: plaintext.byteLength });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${CAPSULE_PREFIX}${base64Url(nonce)}.${base64Url(cipher.getAuthTag())}.${base64Url(ciphertext)}`;
  }

  open(value: string): unknown {
    const match = /^pcvm1_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
    if (match === null || value.length > 131_072) {
      throw new Error("Persistent machine capsule was invalid");
    }
    const nonce = decode(match[1]!);
    const tag = decode(match[2]!);
    const ciphertext = decode(match[3]!);
    if (nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength < 2) {
      throw new Error("Persistent machine capsule was invalid");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: 16 });
      decipher.setAAD(AAD, { plaintextLength: ciphertext.byteLength });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch {
      throw new Error("Persistent machine capsule authentication failed");
    }
  }
}
