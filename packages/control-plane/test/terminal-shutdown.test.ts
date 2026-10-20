import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("closes the Sandbox control after refusing an upgrade during its drain", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/terminal-shutdown.mjs", import.meta.url)),
    ],
    { timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  expect(result.stdout).toContain("owned_terminal_shutdown_settled");
});
