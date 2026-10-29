import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contracts } from "./contracts.mjs";

const directory = resolve(
  process.argv[2] ?? "deploy/production/runtime/work-evidence/shared-history-roots-20261029",
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { at: new Date().toISOString(), completed: false, productionReady: false };
try {
  report.contracts = await contracts();
  if (process.argv.includes("--bench")) {
    const { benchmark } = await import("./benchmark.mjs");
    report.benchmark = await benchmark(directory);
  }
  report.completed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}
