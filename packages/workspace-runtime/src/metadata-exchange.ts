import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";

export function exchangeUploadMetadata(
  directory: FileHandle,
  lock: FileHandle,
  slot: "recovery-a" | "recovery-b",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PI_CLOUD_FILE_EXCHANGE_PATH ?? "/opt/pi-cloud/bin/file-exchange",
      [slot],
      {
        stdio: ["ignore", "ignore", "ignore", directory.fd, lock.fd],
      },
    );
    let spawnError: Error | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    timer.unref();
    child.once("error", (error) => {
      spawnError = error;
    });
    // Do not settle on timeout/kill alone: the inherited lock must remain held
    // until an exchange already in the kernel has actually exited.
    child.once("close", (code) => {
      clearTimeout(timer);
      if (spawnError || code !== 0)
        reject(new Error("Upload metadata commit is unconfirmed", { cause: spawnError }));
      else resolve();
    });
  });
}
