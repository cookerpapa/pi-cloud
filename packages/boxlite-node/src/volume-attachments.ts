import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { AllocationReceipt } from "./allocation-receipt.ts";

const execute = promisify(execFile);
/** Reuses the existing POSIX provider attachment contract and deletion lock.
 * The SDK receives only the Workspace leaf, never private ownership files. */
export class VolumeAttachments {
  constructor(
    readonly plugin: string,
    readonly namespace: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(namespace)) throw new Error("Invalid provider namespace");
  }
  async #call(operation: string, volumeId: string, extra: string[] = []) {
    if (!/^pcw-[0-9a-f]{48}$/.test(volumeId)) throw new Error("Invalid Workspace volume identity");
    const { stdout } = await execute(
      this.plugin,
      ["--op", operation, "--volume-id", volumeId, ...extra],
      {
        timeout: 30000,
        maxBuffer: 65536,
      },
    );
    const value = JSON.parse(stdout) as Record<string, unknown>;
    if (value.error !== "") throw new Error("Workspace attachment was not confirmed");
    return value;
  }
  async attach(volumeId: string, activationId: string): Promise<AllocationReceipt["attachment"]> {
    const value = await this.#call("attach", volumeId, [
      "--sandbox-id",
      activationId,
      "--namespace",
      this.namespace,
      "--ref-count",
      "0",
    ]);
    const expected = `/data/cube-shared/volume/picloud-posix-${volumeId}/workspace`;
    if (value.host_path !== expected || (await realpath(expected)) !== expected || !value.metadata)
      throw new Error("Workspace attachment identity changed");
    return {
      volumeId,
      namespace: this.namespace,
      sandboxId: activationId,
      metadata: value.metadata,
      hostPath: expected,
    };
  }
  async detach(receipt: AllocationReceipt["attachment"]): Promise<void> {
    if (receipt.namespace !== this.namespace)
      throw new Error("Workspace provider identity changed");
    await this.#call("detach", receipt.volumeId, [
      "--sandbox-id",
      receipt.sandboxId,
      "--namespace",
      receipt.namespace,
      "--ref-count",
      "0",
      "--metadata",
      JSON.stringify(receipt.metadata),
    ]);
  }
}
