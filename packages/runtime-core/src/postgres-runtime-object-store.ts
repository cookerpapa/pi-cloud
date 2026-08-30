import type { Database } from "@pi-cloud/database";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import {
  MAX_RUNTIME_OBJECT_BYTES,
  WorkspaceSettlementStoreError,
  validateRuntimeObjectKey,
  type RuntimeObjectStore,
} from "./workspace-settlement-store.ts";

/**
 * Small immutable Agent artifacts live beside their transactional metadata.
 * Workspace bytes are deliberately excluded: Cube persistent volumes own them.
 */
export class PostgresRuntimeObjectStore implements RuntimeObjectStore {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    const key = validateRuntimeObjectKey(objectKey);
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_RUNTIME_OBJECT_BYTES) {
      throw new WorkspaceSettlementStoreError(
        "runtime_object_invalid",
        "Runtime object is outside its byte limit",
        false,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    await this.#database
      .insertInto("runtime_objects")
      .values({
        object_key: key,
        bytes: Buffer.from(bytes),
        sha256: digest,
        size_bytes: bytes.byteLength,
      })
      .onConflict((conflict) => conflict.column("object_key").doNothing())
      .executeTakeFirst();
    const stored = await this.#database
      .selectFrom("runtime_objects")
      .select(["sha256", "size_bytes"])
      .where("object_key", "=", key)
      .executeTakeFirstOrThrow();
    if (stored.sha256 !== digest || Number(stored.size_bytes) !== bytes.byteLength) {
      throw new WorkspaceSettlementStoreError(
        "runtime_object_conflict",
        "Runtime object key already contains different bytes",
        false,
      );
    }
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const row = await this.#database
      .selectFrom("runtime_objects")
      .select(["bytes", "sha256", "size_bytes"])
      .where("object_key", "=", validateRuntimeObjectKey(objectKey))
      .executeTakeFirst();
    if (row === undefined) {
      throw new WorkspaceSettlementStoreError(
        "runtime_object_not_found",
        "Runtime object was not found",
        false,
      );
    }
    const bytes = new Uint8Array(row.bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > MAX_RUNTIME_OBJECT_BYTES ||
      Number(row.size_bytes) !== bytes.byteLength ||
      row.sha256 !== digest
    ) {
      throw new WorkspaceSettlementStoreError(
        "runtime_object_invalid",
        "Runtime object failed its integrity check",
        false,
      );
    }
    return bytes;
  }

  async delete(objectKey: string): Promise<void> {
    await this.#database
      .deleteFrom("runtime_objects")
      .where("object_key", "=", validateRuntimeObjectKey(objectKey))
      .execute();
  }

  async checkHealth(): Promise<void> {
    await this.#database.selectFrom("runtime_objects").select("object_key").limit(1).execute();
  }

  destroy(): void {
    // Connection ownership remains with the service runtime.
  }
}
