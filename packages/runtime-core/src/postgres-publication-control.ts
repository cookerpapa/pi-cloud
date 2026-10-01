import type { Database } from "@pi-cloud/database";
import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely } from "kysely";
import type { AcceptedExecutionSealFact, ExecutionPublication } from "./accepted-fact.ts";
import {
  PublicationIngressRejected,
  type PublicationOwnership,
  type SessionPublicationIngress,
} from "./session-publication-ingress.ts";

/** PG access belongs to admission/closure, never the ordinary append callback. */
export class PostgresPublicationControl {
  constructor(
    readonly database: Kysely<Database>,
    readonly ingress: SessionPublicationIngress,
    readonly beforeSeal?: (fact: AcceptedExecutionSealFact) => Promise<void>,
  ) {}

  async open(owner: PublicationOwnership, permit: ExecutionPublication): Promise<void> {
    const scope = permit.scope;
    const admission = this.ingress.beginAdmission(owner, scope);
    try {
      const row = await this.database
        .selectFrom("runs as r")
        .innerJoin("session_leases as l", "l.lease_id", "r.lease_id")
        .select("r.output_publication")
        .where("r.tenant_id", "=", scope.tenantId)
        .where("r.id", "=", scope.runId)
        .where("l.tenant_id", "=", scope.tenantId)
        .where("l.pi_session_id", "=", scope.piSessionId)
        .where("l.lease_id", "=", scope.writerId)
        .where("l.fencing_token", "=", String(scope.fencingToken))
        .where("l.released_at", "is", null)
        .where("l.writer_failed_at", "is", null)
        .where("l.writer_sealed_at", "is", null)
        .where("l.valid_until", ">", sql<Date>`clock_timestamp()`)
        .where("r.output_seal_id", "is", null)
        .where("r.state", "in", ["running", "settling", "cancel_requested"])
        .executeTakeFirst();
      if (!row || !isDeepStrictEqual(row.output_publication, permit))
        throw new PublicationIngressRejected("scope");
      // A completed closure must also invalidate a PG snapshot that began earlier.
      this.ingress.installRun(owner, permit, admission);
    } finally {
      admission.release();
    }
  }

  async seal(owner: PublicationOwnership, fact: AcceptedExecutionSealFact) {
    const row = await this.database
      .selectFrom("outbox as o")
      .innerJoin("runs as r", "r.output_seal_id", "o.id")
      .select(["o.payload", "r.output_sealed_at"])
      .where("o.tenant_id", "=", fact.scope.tenantId)
      .where("o.id", "=", fact.factId)
      .where("r.tenant_id", "=", fact.scope.tenantId)
      .where("r.id", "=", fact.scope.runId)
      .executeTakeFirst();
    if (!row || !isDeepStrictEqual(row.payload, fact))
      throw new PublicationIngressRejected("scope");
    if (row.output_sealed_at !== null) {
      this.ingress.confirmSealed(owner, fact);
      return { factId: fact.factId, durable: true as const };
    }
    return this.ingress.seal(owner, fact, this.beforeSeal && (() => this.beforeSeal!(fact)));
  }
}
