import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("collects disposed workflow results while the Run bindings and old callbacks remain", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/workflow-retention.mjs", import.meta.url)),
    ],
    { timeout: 25_000 },
  );
  expect(JSON.parse(stdout.trim())).toMatchObject({
    completedAndDisposedTools: 64,
    retainedWhileRunOpen: 0,
    retainedClosedCallbacks: 64,
    retainedAfterBindingRelease: 0,
  });
}, 30_000);
