import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { AcceptedToolCommand } from "./tool-command.ts";
import type { ExecutionEvidence } from "./execution-probe.ts";

export type ToolCompletionContext = {
  kind?: never;
  scope: AcceptedToolCommand["scope"];
  replyTopic: string;
  toolCallId: string;
  nativeToolCallId: string;
  toolName: string;
  partition: number;
  execution?: Omit<ExecutionEvidence, "observedAt">;
};
export type ProbeCompletionContext = {
  kind: "execution_probe";
  replyTopic: string;
  sentAt: number;
  bindingIds: string[];
  execution: Omit<ExecutionEvidence, "observedAt">;
};
export type ToolCompletionGrant = {
  operationId: string;
  expiresAt: number;
  context: ToolCompletionContext | ProbeCompletionContext;
};
const purpose = Buffer.from("pi-cloud.tool-completion.v2");

/** The same bounded AES-GCM capsule pattern as persistent VM capsules, with
 * a separate purpose-derived key. This is delivery authority, never execution
 * authority or a signature certifying Guest output as truthful. */
export class ToolCompletionCapabilities {
  readonly #key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error("Completion authority key is unavailable");
    this.#key = createHmac("sha256", secret).update(purpose).digest();
  }
  issue(grant: ToolCompletionGrant): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(purpose);
    const bytes = Buffer.from(JSON.stringify(grant));
    if (bytes.length > 4096) throw new Error("Completion grant exceeds its scope bound");
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return "pctc2_" + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
  }
  read(value: string, now = Date.now()): ToolCompletionGrant {
    if (!/^pctc2_[A-Za-z0-9_-]+$/.test(value) || value.length > 8192)
      throw new Error("Invalid completion capability");
    const bytes = Buffer.from(value.slice(6), "base64url");
    if (bytes.length < 30) throw new Error("Invalid completion capability");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
    decipher.setAAD(purpose);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const grant = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
    ) as ToolCompletionGrant;
    if (
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= now ||
      !/^[0-9a-f-]{36}$/.test(grant.operationId) ||
      !grant.context
    )
      throw new Error("Expired or invalid completion capability");
    return grant;
  }
}
