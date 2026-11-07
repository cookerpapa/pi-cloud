import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import {
  workspaceVolumeId,
  type WorkspaceVolumeGateway,
} from "./workspace-volume-gateway-contract.ts";

/** Fulfil persisted storage intent through the existing resource owner. The
 * partial index contains only undelivered growth; cold Volume creation always
 * enforces the current intent before publishing its initial marker. */
export class WorkspaceCapacityReconciler {
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #cursor: string | undefined;
  #abort = new AbortController();
  constructor(
    readonly database: Kysely<Database>,
    readonly domainId: string,
    readonly gateway: WorkspaceVolumeGateway,
  ) {}
  start(onError: () => void): void {
    const run = () => {
      if (!this.#running)
        this.#running = this.runOnce()
          .catch(onError)
          .finally(() => {
            this.#running = undefined;
          });
    };
    run();
    this.#timer = setInterval(run, 5000);
    this.#timer.unref();
  }
  async runOnce(): Promise<void> {
    const read = async () => {
      let query = this.database
        .selectFrom("workspaces")
        .select(["id", "tenant_id", "capacity_revision"])
        .where("sandbox_domain_id", "=", this.domainId)
        .where("deleted_at", "is", null)
        .where("capacity_pending", "=", true)
        .orderBy("id")
        .limit(32);
      if (this.#cursor) query = query.where("id", ">", this.#cursor);
      return query.execute();
    };
    let rows = await read();
    if (!rows.length && this.#cursor) {
      this.#cursor = undefined;
      rows = await read();
    }
    const failures: unknown[] = [];
    for (const row of rows) {
      if (this.#abort.signal.aborted) return;
      this.#cursor = row.id;
      const identity = { tenantId: row.tenant_id, workspaceId: row.id };
      try {
        await this.gateway.reconcileQuota(
          {
            ...identity,
            volumeId: workspaceVolumeId(identity),
            revision: Number(row.capacity_revision),
          },
          AbortSignal.any([this.#abort.signal, AbortSignal.timeout(75_000)]),
        );
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Some Workspace capacity changes remain pending");
  }
  async close(): Promise<void> {
    this.#abort.abort();
    if (this.#timer) clearInterval(this.#timer);
    await this.#running;
  }
}
