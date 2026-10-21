import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Reuse Linux flock; the OS releases exclusion even if the operator is killed. */
export function serializeRelease(runtimeDirectory) {
  if (process.env.PI_CLOUD_RELEASE_LOCKED === "1") return;
  mkdirSync(resolve(runtimeDirectory, "k3s"), { recursive: true, mode: 0o700 });
  try {
    execFileSync(
      "flock",
      [
        "--nonblock",
        resolve(runtimeDirectory, "k3s/release.lock"),
        process.execPath,
        ...process.execArgv,
        ...process.argv.slice(1),
      ],
      {
        stdio: "inherit",
        env: { ...process.env, PI_CLOUD_RELEASE_LOCKED: "1" },
      },
    );
    process.exit(0);
  } catch (error) {
    process.exit(typeof error.status === "number" ? error.status : 1);
  }
}
