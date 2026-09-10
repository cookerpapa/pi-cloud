import type { Pool } from "pg";
import type { WorkspaceVolumeGatewayLock } from "./workspace-volume-gateway-contract.ts";

export class PostgresWorkspaceVolumeGatewayLock implements WorkspaceVolumeGatewayLock {
  constructor(readonly pool: Pick<Pool, "connect">) {}

  async withLock<T>(volumeId: string, run: () => Promise<T>): Promise<T> {
    return this.withLocks([volumeId], run);
  }

  async withLocks<T>(volumeIds: readonly string[], run: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(volumeIds)].sort();
    if (ordered.length < 1) return run();
    const client = await this.pool.connect();
    let discard: Error | undefined;
    let failed = false,
      failure: unknown,
      result!: T;
    const lost = (error: Error) => {
      discard ??= error;
    };
    client.on("error", lost);
    try {
      for (const volumeId of ordered)
        await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
          `pi-cloud.workspace.${volumeId}`,
        ]);
      result = await run();
      if (discard) throw discard;
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      // The pool is dedicated to Volume locks. One statement releases every
      // acquired key, including a partial acquisition; no open DB transaction
      // spans filesystem work. Never reuse a session with uncertain cleanup.
      if (!discard) await client.query("select pg_advisory_unlock_all()");
    } catch (error) {
      discard = error instanceof Error ? error : new Error("Volume unlock failed");
      if (!failed) {
        failed = true;
        failure = error;
      }
    } finally {
      client.off("error", lost);
      client.release(discard);
    }
    if (failed) throw failure;
    return result;
  }
}
