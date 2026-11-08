import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseToolCatalogPublication,
  type ToolCatalogPublication,
  type ControlToolCatalog,
} from "@pi-cloud/protocol";

type Row = {
  generation: string;
  release_id: string;
  catalog: string;
  replayable: string[];
  published_generation: string | null;
};

function publication(row: Row): ToolCatalogPublication {
  return parseToolCatalogPublication({
    version: 1,
    scope: "platform",
    generation: Number(row.generation),
    releaseId: row.release_id,
    catalog: JSON.parse(row.catalog),
    replayable: row.replayable,
  });
}

/** One selected release, not a second tool scheduler. Only deployment activation
 * changes this current value; restarting an old executable cannot select itself. */
export class ToolCatalogAuthority {
  constructor(readonly database: Kysely<Database>) {}

  async read(): Promise<ToolCatalogPublication | undefined> {
    const { rows } = await sql<Row>`select generation::text,release_id,catalog,replayable,
      published_generation::text from tool_catalog_publication where scope='platform'`.execute(
      this.database,
    );
    return rows[0] ? publication(rows[0]) : undefined;
  }

  async select(input: {
    releaseId: string;
    catalog: ControlToolCatalog;
    replayable: readonly string[];
    expectedGeneration: number;
  }): Promise<ToolCatalogPublication> {
    parseToolCatalogPublication({
      version: 1,
      scope: "platform",
      generation: 1,
      releaseId: input.releaseId,
      catalog: input.catalog,
      replayable: [...input.replayable],
    });
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0)
      throw new Error("Invalid expected catalog generation");
    return this.database.transaction().execute(async (tx) => {
      // Serializes only rare release selections. No lock spans Kafka or HTTP.
      await sql`select pg_advisory_xact_lock(713013,16)`.execute(tx);
      const { rows } = await sql<Row>`select generation::text,release_id,catalog,replayable,
        published_generation::text from tool_catalog_publication where scope='platform' for update`.execute(
        tx,
      );
      const old = rows[0];
      if (old?.release_id === input.releaseId) {
        if (
          (JSON.parse(old.catalog) as ControlToolCatalog).revision !== input.catalog.revision ||
          JSON.stringify([...old.replayable].sort()) !==
            JSON.stringify([...input.replayable].sort())
        )
          throw new Error("Tool release identity changed its catalog");
        return publication(old);
      }
      if (Number(old?.generation ?? 0) !== input.expectedGeneration)
        throw new Error("Tool catalog selection changed; refresh before activation");
      const generation = input.expectedGeneration + 1;
      await sql`insert into tool_catalog_publication(scope,generation,release_id,catalog,replayable)
        values('platform',${generation},${input.releaseId},${JSON.stringify(input.catalog)},
          ${JSON.stringify([...input.replayable].sort())}::jsonb)
        on conflict(scope) do update set generation=excluded.generation,
          release_id=excluded.release_id,catalog=excluded.catalog,replayable=excluded.replayable,
          published_generation=null,updated_at=clock_timestamp()`.execute(tx);
      return parseToolCatalogPublication({
        version: 1,
        scope: "platform",
        generation,
        releaseId: input.releaseId,
        catalog: input.catalog,
        replayable: [...input.replayable].sort(),
      });
    });
  }

  async current(value: ToolCatalogPublication): Promise<boolean> {
    const { rows } = await sql`select 1 from tool_catalog_publication where scope='platform'
      and generation=${value.generation} and release_id=${value.releaseId}
      and catalog::jsonb->>'revision'=${value.catalog.revision}`.execute(this.database);
    return rows.length === 1;
  }

  async confirmPublished(value: ToolCatalogPublication): Promise<void> {
    const result = await sql`update tool_catalog_publication
      set published_generation=generation,updated_at=clock_timestamp()
      where scope='platform' and generation=${value.generation}
        and release_id=${value.releaseId} and catalog::jsonb->>'revision'=${value.catalog.revision}`.execute(
      this.database,
    );
    if (result.numAffectedRows !== 1n)
      throw new Error("Catalog changed before publication confirmation");
  }
}
