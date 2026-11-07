import { Agent, fetch } from "undici";
import type { WorkspaceVolumeGatewayVolumeIdentity } from "./workspace-volume-gateway-contract.ts";

export type WorkspaceQuotaIdentity = WorkspaceVolumeGatewayVolumeIdentity & { generation: string };
export type WorkspaceQuotaSnapshot = {
  state: "ready" | "pending";
  capacityBytes: number;
  usedBytes: number;
  revision: number;
};
const dispatcher = new Agent();

/** Typed storage policy adapter. No shell, filenames or provider credentials cross it. */
export class WorkspaceQuotaClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !token
    )
      throw new TypeError("Invalid Workspace quota endpoint");
  }
  async #request(path: string, body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: body ? "POST" : "GET",
      dispatcher,
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Workspace quota request failed (${response.status})`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing quota receipt");
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 8192) throw new Error("Quota receipt exceeds its bound");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }
  async ensure(
    identity: WorkspaceQuotaIdentity,
    revision: number,
    capacityBytes: number,
  ): Promise<WorkspaceQuotaSnapshot> {
    return this.#snapshot(
      await this.#request("/v1/quota/ensure", { ...identity, revision, capacityBytes }),
    );
  }
  async read(identity: WorkspaceQuotaIdentity): Promise<WorkspaceQuotaSnapshot> {
    return this.#snapshot(await this.#request("/v1/quota/read", identity));
  }
  async release(identity: WorkspaceVolumeGatewayVolumeIdentity): Promise<void> {
    if ((await this.#request("/v1/quota/release", identity)).released !== true)
      throw new Error("Quota release is unconfirmed");
  }
  async checkHealth(): Promise<void> {
    await this.#request("/v1/pool");
  }
  #snapshot(value: Record<string, unknown>): WorkspaceQuotaSnapshot {
    if (
      !["ready", "pending"].includes(String(value.state)) ||
      ![value.capacityBytes, value.usedBytes, value.revision].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw new Error("Invalid quota receipt");
    return value as WorkspaceQuotaSnapshot;
  }
}

export function validateQuotaEnforcement(value: unknown, identity: WorkspaceQuotaIdentity): void {
  const record = value as Record<string, unknown>;
  if (
    !record ||
    record.version !== 1 ||
    record.tenantId !== identity.tenantId ||
    record.workspaceId !== identity.workspaceId ||
    record.volumeId !== identity.volumeId ||
    record.generation !== identity.generation ||
    !Number.isSafeInteger(record.projectId) ||
    Number(record.projectId) <= 0 ||
    typeof record.filesystemId !== "string"
  )
    throw new Error("Workspace quota enforcement identity changed");
}
