import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  VOLUME_IDENTITY_FILE,
  VOLUME_METADATA_DIRECTORY,
  WorkspaceVolumeGatewayError,
  validatedAbsoluteDirectory,
  type WorkspaceVolumeGatewayLock,
} from "./workspace-volume-gateway-contract.ts";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LOCK_FILE = "gateway.lock";
const missing = () =>
  new WorkspaceVolumeGatewayError(
    "workspace_volume_identity_unavailable",
    "Workspace Volume identity is unavailable",
    false,
  );

/** The Node-owned open file description holds flock after the utility exits.
 * PG connection loss cannot release it while filesystem work is still running. */
export class FilesystemWorkspaceVolumeGatewayLock implements WorkspaceVolumeGatewayLock {
  readonly #root: string;
  constructor(
    root: string,
    readonly waitMs = 30_000,
  ) {
    this.#root = validatedAbsoluteDirectory(root, "workspaceRoot");
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 600_000)
      throw new TypeError("Invalid filesystem lock wait");
  }

  async withLock<T>(
    volumeId: string,
    run: () => Promise<T>,
    whenAbsent?: () => Promise<T>,
  ): Promise<T> {
    if (!/^pcw-[0-9a-f]{48}$/.test(volumeId)) throw new TypeError("Invalid Volume lock identity");
    const path = join(this.#root, `picloud-posix-${volumeId}`);
    let volume: FileHandle;
    try {
      volume = await open(path, DIRECTORY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (whenAbsent) return whenAbsent();
        throw missing();
      }
      throw error;
    }
    let directory: FileHandle | undefined, lock: FileHandle | undefined;
    try {
      directory = await open(`/proc/self/fd/${volume.fd}/${VOLUME_METADATA_DIRECTORY}`, DIRECTORY);
      const identity = await open(
        `/proc/self/fd/${directory.fd}/${VOLUME_IDENTITY_FILE}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await identity.stat();
        if (!stat.isFile() || stat.size > 256) throw missing();
        const content = await identity.readFile("utf8");
        if (!new RegExp(`^pi-cloud-volume-v1\\n${volumeId}\\n[0-9a-f]{64}\\n?$`).test(content))
          throw missing();
      } finally {
        await identity.close();
      }
      // Only a published plugin envelope may receive this derived lock file.
      lock = await open(
        `/proc/self/fd/${directory.fd}/${LOCK_FILE}`,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      const held = await lock.stat({ bigint: true });
      if (!held.isFile() || held.size !== 0n) throw new Error("Invalid Volume lock file");
      await this.#acquire(lock.fd);
      const current = await lstat(join(path, VOLUME_METADATA_DIRECTORY, LOCK_FILE), {
        bigint: true,
      });
      if (current.ino !== held.ino || current.dev !== held.dev || !current.isFile())
        throw new WorkspaceVolumeGatewayError(
          "workspace_volume_binding_invalid",
          "Volume lock identity changed",
          true,
        );
      return await run();
    } finally {
      // The callback is joined before the last held descriptor closes.
      await Promise.all([lock?.close(), directory?.close(), volume.close()]);
    }
  }

  #acquire(fd: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/flock",
        ["--exclusive", "--timeout", String(this.waitMs / 1000), "3"],
        {
          stdio: ["ignore", "ignore", "ignore", fd],
          timeout: this.waitMs + 1000,
        },
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new WorkspaceVolumeGatewayError(
              "workspace_volume_lock_unavailable",
              "Workspace Volume is busy or its filesystem lock is unavailable",
              true,
            ),
          );
      });
    });
  }
}
