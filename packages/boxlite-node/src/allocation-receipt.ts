import { createHash, randomUUID } from "node:crypto";
import { open, readFile, mkdir, link, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { GuestRuntimeCreateInput } from "@pi-cloud/sandbox-control/guest-runtime";

/** Immutable connection/attachment metadata missing from the embedded SDK's
 * public info API. PG remains allocation, expiry and quota authority. */
export type AllocationReceipt = Readonly<{
  version: 1;
  activationId: string;
  request: GuestRuntimeCreateInput;
  attachment: {
    volumeId: string;
    namespace: string;
    sandboxId: string;
    metadata: unknown;
    hostPath: string;
  };
}>;

export const allocationName = (id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid allocation identity");
  return `pma-${id}`;
};
export function allocationFromName(name: string | undefined): string | undefined {
  return name && /^pma-[0-9a-f-]{36}$/.test(name) ? name.slice(4) : undefined;
}

export class AllocationReceipts {
  constructor(readonly directory: string) {}
  async count(): Promise<number> {
    try {
      return (await readdir(this.directory)).length;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }
  async read(id: string): Promise<AllocationReceipt | undefined> {
    const path = join(this.directory, allocationName(id) + ".json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (Buffer.byteLength(text) > 65536) throw new Error("Allocation receipt exceeded its bound");
    const data = JSON.parse(text) as { receipt: AllocationReceipt; sha256: string };
    if (
      data.receipt?.version !== 1 ||
      data.receipt.activationId !== id ||
      createHash("sha256").update(JSON.stringify(data.receipt)).digest("hex") !== data.sha256
    )
      throw new Error("Allocation receipt is incomplete or changed");
    return data.receipt;
  }
  async save(receipt: AllocationReceipt): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(receipt);
    if (Buffer.byteLength(body) > 60000) throw new Error("Allocation receipt exceeded its bound");
    const value = JSON.stringify({
      receipt,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
    const destination = join(this.directory, allocationName(receipt.activationId) + ".json");
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !isDeepStrictEqual(await this.read(receipt.activationId), receipt)
        )
          throw error;
      }
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary);
    }
  }
  /** Caller must first confirm physical closure and detach the exact receipt. */
  async forget(id: string): Promise<void> {
    await unlink(join(this.directory, allocationName(id) + ".json"));
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
