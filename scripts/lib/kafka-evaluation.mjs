import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testKafka } from "./test-kafka.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
export async function kafkaEvaluation(defaultOutput, evaluate) {
  const fixture = await testKafka();
  let report;
  try {
    report = await evaluate(fixture.brokers);
  } finally {
    await fixture.close();
  }
  report.revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  report.workingTreeDirty = !!execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const output = resolve(root, process.env.PI_CLOUD_EVAL_OUTPUT ?? defaultOutput);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  return report;
}
