import type { Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parsePutResourceBackend,
  parseRegisterResourceDevice,
  RESOURCE_BACKENDS_INTERNAL_PATH,
  type ResourceBackendResource,
} from "@pi-cloud/protocol";

/** API-side directory/relay. It has no native adapter or credential decryption key. */
export class ResourceBackendService {
  constructor(
    readonly database: Kysely<Database>,
    readonly management?: { url: string; token: string },
  ) {}
  async catalog(administrator = false): Promise<{ backends: readonly ResourceBackendResource[] }> {
    let query = this.database
      .selectFrom("sandbox_domains")
      .select("backend_catalog")
      .where("backend_revision", ">", "0")
      .orderBy("display_name")
      .orderBy("id");
    if (!administrator) query = query.where("state", "=", "active");
    const rows = await query.execute();
    return {
      backends: rows.map((row) => row.backend_catalog as unknown as ResourceBackendResource),
    };
  }
  async put(input: unknown): Promise<ResourceBackendResource> {
    return this.#send<ResourceBackendResource>(
      "PUT",
      RESOURCE_BACKENDS_INTERNAL_PATH,
      parsePutResourceBackend(input),
    );
  }
  registerDevice(tenantId: string, input: unknown) {
    return this.#send("POST", RESOURCE_BACKENDS_INTERNAL_PATH + "/devices", {
      tenantId,
      device: parseRegisterResourceDevice(input),
    });
  }
  async #send<T>(method: "PUT" | "POST", path: string, request: unknown): Promise<T> {
    if (!this.management) throw new Error("Resource registration is unavailable");
    const response = await fetch(new URL(path, this.management.url), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(150_000),
      headers: {
        authorization: `Bearer ${this.management.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (!response.body) throw new Error("Resource registration returned no confirmation");
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error("Resource registration response exceeded its bound");
        chunks.push(chunk);
      }
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok)
      throw new ResourceBackendChangeError(
        typeof body.message === "string" ? body.message : "Resource registration was not accepted",
      );
    return body as T;
  }
}
export class ResourceBackendChangeError extends Error {}
