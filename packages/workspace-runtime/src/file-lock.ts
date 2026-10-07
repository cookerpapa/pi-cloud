import { spawn } from "node:child_process";

/** The caller owns the open description for the entire protected operation. */
export function acquireFileLock(fd: number, shared: boolean, waitMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/flock",
      [
        shared ? "--shared" : "--exclusive",
        "--conflict-exit-code",
        "75",
        ...(waitMs === 0 ? ["--nonblock"] : ["--timeout", String(waitMs / 1000)]),
        "3",
      ],
      { stdio: ["ignore", "ignore", "ignore", fd], timeout: waitMs + 1000 },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(true);
      else if (code === 75) resolve(false);
      else reject(new Error("Filesystem lock acquisition failed"));
    });
  });
}
