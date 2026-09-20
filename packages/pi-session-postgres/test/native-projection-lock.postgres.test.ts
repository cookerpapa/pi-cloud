import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { PostgresPiSessionStorage } from "../src/postgres-session-storage.ts";
import { projectNativeSessionAppend } from "../src/project-native-session-append.ts";
import type { PiCommittedItem } from "../src/session-mutation.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "reads the committed Lane head after waiting for the previous projector's Session lock",
  async () => {
    const admin = createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 1,
    });
    const name = `pi_native_lock_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!);
    url.pathname = `/${name}`;
    url.searchParams.set(
      "options",
      "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
    );
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 3 });
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    try {
      await runMigrations(db, "up");
      const tenantId = randomUUID(),
        sessionId = randomUUID();
      await db.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
      const storage = await PostgresPiSessionStorage.create({ database: db, tenantId, sessionId });
      const items: PiCommittedItem[] = [
        {
          kind: "entry",
          lane: "main",
          turnId: null,
          entry: {
            id: "first",
            type: "custom",
            customType: "state",
            seq: 1,
            parentId: null,
            timestamp: 1,
          },
        },
        {
          kind: "entry",
          lane: "main",
          turnId: null,
          entry: {
            id: "second",
            type: "custom",
            customType: "state",
            seq: 2,
            parentId: "first",
            timestamp: 2,
          },
        },
      ];
      const blocked = new WeakSet<object>();
      const measured = db.withPlugin({
        transformQuery({ node, queryId }) {
          if (
            db
              .getExecutor()
              .compileQuery(node, queryId)
              .sql.startsWith('insert into "pi_session_log"')
          )
            blocked.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (blocked.has(queryId)) {
            held.resolve();
            await release.promise;
          }
          return result;
        },
      });
      first = measured.transaction().execute((tx) =>
        projectNativeSessionAppend(tx, {
          tenantId,
          sessionId,
          appendId: randomUUID(),
          items: [items[0]!],
        }),
      );
      void first.catch(held.reject);
      await held.promise;
      second = db.transaction().execute((tx) =>
        projectNativeSessionAppend(tx, {
          tenantId,
          sessionId,
          appendId: randomUUID(),
          items: [items[1]!],
        }),
      );
      await vi.waitFor(async () => {
        const { rows } = await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where datname=${name} and wait_event_type='Lock'`.execute(
          admin,
        );
        expect(rows[0]!.n).toBeGreaterThan(0);
      });
      release.resolve();
      await Promise.all([first, second]);
      expect(await storage.getLanes()).toEqual([{ lane: "main", leafId: "second" }]);
      expect(await storage.getEntry("second")).toEqual(
        items[1]!.kind === "entry" ? items[1]!.entry : undefined,
      );
      expect(await storage.getLog()).toHaveLength(2);
    } finally {
      release.resolve();
      await Promise.allSettled([...(first ? [first] : []), ...(second ? [second] : [])]);
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60000,
);
