import type { Database } from "@pi-cloud/database";
import type { SshAccessTicketResource } from "@pi-cloud/protocol";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

const DEFAULT_TICKET_TTL_MS = 24 * 60 * 60_000;

export type SshAccessTicketServiceOptions = Readonly<{
  database: Kysely<Database>;
  enabled?: boolean;
  advertisedHost?: string;
  advertisedPort?: number;
  ticketTtlMs?: number;
  clock?: () => Date;
  idGenerator?: () => string;
  secretGenerator?: () => string;
}>;

function validHost(value: string): string {
  const host = value.trim();
  if (
    host.length < 1 ||
    host.length > 253 ||
    !/^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/.test(host)
  ) {
    throw new TypeError("SSH advertised host is invalid");
  }
  return host;
}

export class SshAccessTicketService {
  readonly #database: Kysely<Database>;
  readonly #enabled: boolean;
  readonly #host: string;
  readonly #port: number;
  readonly #ttlMs: number;
  readonly #clock: () => Date;
  readonly #id: () => string;
  readonly #secret: () => string;

  constructor(options: SshAccessTicketServiceOptions) {
    this.#database = options.database;
    this.#enabled = options.enabled ?? false;
    this.#host = validHost(options.advertisedHost ?? "127.0.0.1");
    this.#port = options.advertisedPort ?? 2_222;
    if (!Number.isSafeInteger(this.#port) || this.#port < 1 || this.#port > 65_535) {
      throw new TypeError("SSH advertised port is invalid");
    }
    this.#ttlMs = options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs < 60_000 ||
      this.#ttlMs > 24 * 60 * 60_000
    ) {
      throw new TypeError("SSH access ticket TTL is invalid");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#id = options.idGenerator ?? randomUUID;
    this.#secret = options.secretGenerator ?? (() => randomBytes(32).toString("base64url"));
  }

  async issue(
    identity: TenantRequestIdentity,
    sessionId: string,
  ): Promise<SshAccessTicketResource> {
    if (!this.#enabled) {
      throw new ControlPlaneStoreError("not_found", "SSH access is not enabled");
    }
    const now = this.#clock();
    const expiresAt = new Date(now.valueOf() + this.#ttlMs);
    const ticketId = this.#id();
    const secret = this.#secret();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw new TypeError("SSH access ticket secret is invalid");
    }
    const password = `pcssh_${ticketId}.${secret}`;
    const secretSha256 = createHash("sha256").update(password, "utf8").digest("hex");
    const environment = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .innerJoin("development_environments as development", (join) =>
        join
          .onRef("development.tenant_id", "=", "session_row.tenant_id")
          .onRef("development.workspace_id", "=", "session_row.workspace_id"),
      )
      .select("development.id as environmentId")
      .where("session_row.tenant_id", "=", identity.tenantId)
      .where("session_row.id", "=", sessionId)
      .where("session_row.archived_at", "is", null)
      .where("session_row.execution_mode", "=", "development_environment")
      .where("workspace.deleted_at", "is", null)
      .where("development.owner_user_id", "=", identity.userId)
      .where("development.state", "=", "running")
      .where("development.agent_activation_id", "is", null)
      .where("development.terminal_active", "=", false)
      .orderBy("development.updated_at", "desc")
      .executeTakeFirst();
    if (environment === undefined) {
      throw new ControlPlaneStoreError(
        "conflict",
        "SSH requires a running exclusive environment with no active Agent or terminal",
      );
    }
    await this.#database
      .insertInto("ssh_access_tickets")
      .values({
        ticket_id: ticketId,
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        session_id: sessionId,
        environment_id: environment.environmentId,
        secret_sha256: secretSha256,
        expires_at: expiresAt,
        consumed_at: null,
        created_at: now,
      })
      .executeTakeFirstOrThrow();
    const command = `ssh -p ${String(this.#port)} picloud@${this.#host}`;
    const oneLineCommand = `SSHPASS='${password}' sshpass -e ssh -o StrictHostKeyChecking=accept-new -p ${String(this.#port)} picloud@${this.#host}`;
    return {
      ticketId,
      sessionId,
      environmentId: environment.environmentId,
      host: this.#host,
      port: this.#port,
      username: "picloud",
      password,
      command,
      oneLineCommand,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
