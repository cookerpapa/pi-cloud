import { readFile } from "node:fs/promises";
import type { Database } from "@pi-cloud/database";
import { IMAGE_OPAQUE_FIELDS, type ImagePacked } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { ImageAttachmentCodec, type ImageScope } from "./codec.ts";
import { PostgresImageAttachmentStore } from "./store.ts";
import { S3ImageBlobStore } from "./s3.ts";

export type ConfiguredImageAttachments = {
  codec: ImageAttachmentCodec;
  store: PostgresImageAttachmentStore;
  blobs: S3ImageBlobStore;
};
export async function configuredImageAttachments(
  database: Kysely<Database>,
  readDatabase: Kysely<Database> = database,
): Promise<ConfiguredImageAttachments | undefined> {
  const endpoint = process.env.PI_CLOUD_IMAGE_S3_ENDPOINT;
  if (!endpoint) return undefined;
  const path = process.env.PI_CLOUD_IMAGE_S3_CREDENTIALS_FILE;
  if (!path) throw new Error("Image S3 credentials file is required");
  const credentials = JSON.parse(await readFile(path, "utf8")) as {
    accessKeyId: string;
    secretAccessKey: string;
  };
  if (!credentials.accessKeyId || !credentials.secretAccessKey)
    throw new Error("Invalid image S3 credentials");
  const blobs = new S3ImageBlobStore({
    endpoint,
    region: process.env.PI_CLOUD_IMAGE_S3_REGION ?? "us-east-1",
    bucket: process.env.PI_CLOUD_IMAGE_S3_BUCKET ?? "pi-cloud-session-images",
    ...credentials,
  });
  const store = new PostgresImageAttachmentStore(database, blobs, readDatabase);
  return { codec: new ImageAttachmentCodec(store), store, blobs };
}

export function containsImage(value: unknown, stored = false): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => containsImage(v, stored));
  const o = value as Record<string, unknown>;
  if (o.type === (stored ? "pi_cloud_image_v1" : "image")) return true;
  return Object.entries(o).some(
    ([key, v]) => !IMAGE_OPAQUE_FIELDS.has(key) && containsImage(v, stored),
  );
}
export async function encodeSessionImages<T>(
  codec: ImageAttachmentCodec | undefined,
  scope: ImageScope,
  value: T,
  signal?: AbortSignal,
): Promise<ImagePacked<T>> {
  if (containsImage(value, true))
    throw new Error("An attachment reference cannot originate in native Tool content");
  if (!containsImage(value)) return value as ImagePacked<T>;
  if (!codec) throw new Error("Session image attachment storage is not configured");
  return codec.pack(scope, value, signal);
}
export async function decodeSessionImages<T>(
  codec: ImageAttachmentCodec | undefined,
  scope: ImageScope,
  value: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!containsImage(value, true)) return value as T;
  if (!codec) throw new Error("Session image attachment storage is not configured");
  return codec.unpack<T>(scope, value as ImagePacked<T>, signal);
}
