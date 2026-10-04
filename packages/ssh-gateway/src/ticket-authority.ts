import type { Database } from "@pi-cloud/database";
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";

const PASSWORD_PATTERN = /^pcssh_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;

export type SshTerminalGrant = Readonly<{
  ticketId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  environmentId: string;
  sandboxDomainId: string;
  sandboxControlBaseUrl: string;
}>;

export class SshTicketAuthority {
  readonly #database: Kysely<Database>;

  constructor(options: { database: Kysely<Database> }) {
    this.#database = options.database;
  }

  async consume(username: string, password: string): Promise<SshTerminalGrant | undefined> {
    if (username !== "picloud" || !PASSWORD_PATTERN.test(password)) return undefined;
    const ticketId = PASSWORD_PATTERN.exec(password)?.[1];
    if (ticketId === undefined) return undefined;
    const digest = createHash("sha256").update(password, "utf8").digest("hex");
    return this.#database.transaction().execute(async (transaction) => {
      const ticket = await transaction
        .selectFrom("ssh_access_tickets as ticket")
        .innerJoin("development_environments as development", (join) =>
          join
            .onRef("development.tenant_id", "=", "ticket.tenant_id")
            .onRef("development.id", "=", "ticket.environment_id"),
        )
        .innerJoin("sandbox_domains as domain", "domain.id", "development.sandbox_domain_id")
        .select([
          "ticket.ticket_id as ticketId",
          "ticket.tenant_id as tenantId",
          "ticket.user_id as userId",
          "ticket.session_id as sessionId",
          "ticket.environment_id as environmentId",
          "development.sandbox_domain_id as sandboxDomainId",
          "development.owner_base_url as ownerBaseUrl",
          "domain.sandbox_control_base_url as fallbackBaseUrl",
        ])
        .where("ticket.ticket_id", "=", ticketId)
        .where("ticket.secret_sha256", "=", digest)
        .where("ticket.consumed_at", "is", null)
        .where("development.owner_user_id", "=", (eb) => eb.ref("ticket.user_id"))
        .where("development.state", "=", "running")
        .where("development.terminal_active", "=", false)
        .where("domain.state", "=", "active")
        .forUpdate("ticket")
        .executeTakeFirst();
      if (ticket === undefined) return undefined;
      const consumed = await transaction
        .updateTable("ssh_access_tickets")
        .set({ consumed_at: sql<Date>`clock_timestamp()` })
        .where("ticket_id", "=", ticket.ticketId)
        // The ticket lock has been acquired: evaluate expiry now, not before
        // waiting for it. PG is the shared issue/consume clock.
        .where("expires_at", ">", sql<Date>`clock_timestamp()`)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      if (consumed.numUpdatedRows !== 1n) return undefined;
      return {
        ticketId: ticket.ticketId,
        tenantId: ticket.tenantId,
        userId: ticket.userId,
        sessionId: ticket.sessionId,
        environmentId: ticket.environmentId,
        sandboxDomainId: ticket.sandboxDomainId,
        sandboxControlBaseUrl: ticket.ownerBaseUrl ?? ticket.fallbackBaseUrl,
      };
    });
  }
}
