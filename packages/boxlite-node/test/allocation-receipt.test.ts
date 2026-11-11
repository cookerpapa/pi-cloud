import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  AllocationReceipts,
  allocationName,
  type AllocationReceipt,
} from "../src/allocation-receipt.ts";

it("retains an exact attachment receipt across reopening and refuses an identity rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "box-receipt-"));
  const id = randomUUID(),
    store = new AllocationReceipts(directory);
  const receipt: AllocationReceipt = {
    version: 1,
    activationId: id,
    request: { templateId: "tool", metadata: { owner: "fixture" } },
    attachment: {
      volumeId: "pcw-" + "a".repeat(48),
      namespace: "boxlite-fixture",
      sandboxId: id,
      metadata: { holder: "b".repeat(64), hold: "c".repeat(64) },
      hostPath: "/owned/workspace",
    },
  };
  try {
    await store.save(receipt);
    await store.save(receipt);
    expect(await new AllocationReceipts(directory).read(id)).toEqual(receipt);
    await expect(
      store.save({ ...receipt, request: { ...receipt.request, metadata: { owner: "other" } } }),
    ).rejects.toThrow();
    expect(await store.read(id)).toEqual(receipt);
    expect(await store.count()).toBe(1);
    await writeFile(join(directory, allocationName(id) + ".json"), '{"receipt":');
    await expect(store.read(id)).rejects.toThrow();
    expect(await store.count()).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
