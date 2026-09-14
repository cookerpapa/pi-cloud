import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { expect, it, vi } from "vitest";
import { PostgresSessionExecutionAuthority } from "../src/postgres-execution-authority.ts";

function fixture() {
  let now = 1000;
  const lookup = vi.fn().mockResolvedValue({ valid_until: new Date(2000) });
  const query = {
    innerJoin() {
      return this;
    },
    select() {
      return this;
    },
    where() {
      return this;
    },
    executeTakeFirst: lookup,
  };
  const authority = new PostgresSessionExecutionAuthority({
    database: { selectFrom: () => query } as unknown as Kysely<Database>,
    tenantId: "tenant",
    piSessionId: "session",
    leaseId: "lease",
    writerId: "writer",
    fencingToken: 1,
    clock: () => new Date(now),
  });
  return {
    authority,
    lookup,
    advance: (value: number) => {
      now = value;
    },
  };
}

it("refreshes an expired observation after slow cold restore instead of revoking a renewed owner", async () => {
  const f = fixture();
  try {
    await f.authority.assertCurrent();
    await f.authority.assertCurrent();
    expect(f.lookup).toHaveBeenCalledTimes(1);
    f.advance(2500);
    f.lookup.mockResolvedValue({ valid_until: new Date(4000) });
    await expect(f.authority.assertCurrent()).resolves.toBeUndefined();
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.authority.signal.aborted).toBe(false);
  } finally {
    await f.authority.close();
  }
});

it("still revokes an owner when the fresh authority lookup rejects it", async () => {
  const f = fixture();
  try {
    await f.authority.assertCurrent();
    f.advance(2500);
    f.lookup.mockResolvedValue(undefined);
    await expect(f.authority.assertCurrent()).rejects.toThrow();
    expect(f.lookup).toHaveBeenCalledTimes(2);
    expect(f.authority.signal.aborted).toBe(true);
  } finally {
    await f.authority.close();
  }
});
