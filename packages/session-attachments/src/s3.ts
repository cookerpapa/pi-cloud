import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import type { ImageBlobStore } from "./store.ts";

export class S3ImageBlobStore implements ImageBlobStore {
  readonly #client: S3Client;
  constructor(
    readonly options: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
  ) {
    const url = new URL(options.endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid attachment S3 endpoint");
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: 2,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  async checkHealth() {
    await this.#client.send(new HeadBucketCommand({ Bucket: this.options.bucket }), {
      abortSignal: AbortSignal.timeout(5000),
    });
  }
  async put(key: string, bytes: Buffer, mimeType: string, signal: AbortSignal) {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: bytes,
        ContentType: mimeType,
        ContentLength: bytes.length,
      }),
      { abortSignal: signal },
    );
  }
  async get(key: string, maximumBytes: number, signal: AbortSignal) {
    const result = await this.#client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { abortSignal: signal },
    );
    const body = result.Body;
    if (!body || result.ContentLength === undefined || result.ContentLength > maximumBytes) {
      if (body && "destroy" in body) body.destroy();
      throw new Error("Invalid image object length");
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) throw new Error("Image object exceeds its byte limit");
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, bytes);
    } finally {
      if ("destroy" in body) body.destroy();
    }
  }
  async delete(key: string, signal: AbortSignal) {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }), {
      abortSignal: signal,
    });
  }
  close() {
    this.#client.destroy();
  }
}
