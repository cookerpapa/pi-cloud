import { expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { retryTransaction } from "../src/retry-transaction.ts";

it.each(["40P01", "40001"])(
  "retries the whole SQL transaction for %s, not its outer effect",
  async (code) => {
    let calls = 0,
      effects = 0;
    const execute = vi.fn(async (body: () => Promise<unknown>) => body());
    const db = { transaction: () => ({ execute }) } as unknown as Kysely<unknown>;
    effects++;
    const value = await retryTransaction(db, async () => {
      if (++calls === 1) throw Object.assign(new Error("rolled back"), { code });
      return "committed";
    });
    expect(value).toBe("committed");
    expect(calls).toBe(2);
    expect(effects).toBe(1);
  },
);
it.each(["ECONNRESET", "08006", "23505"])(
  "does not reinterpret %s as a certain rollback",
  async (code) => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("uncertain or permanent"), { code });
    });
    const db = { transaction: () => ({ execute }) } as unknown as Kysely<unknown>;
    await expect(retryTransaction(db, async () => "never")).rejects.toHaveProperty("code", code);
    expect(execute).toHaveBeenCalledOnce();
  },
);
it("bounds repeated transaction contention", async () => {
  const execute = vi.fn(async () => {
    throw Object.assign(new Error("deadlock"), { code: "40P01" });
  });
  const db = { transaction: () => ({ execute }) } as unknown as Kysely<unknown>;
  await expect(retryTransaction(db, async () => "never")).rejects.toThrow("deadlock");
  expect(execute).toHaveBeenCalledTimes(5);
});
