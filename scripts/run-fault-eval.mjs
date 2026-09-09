import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testedRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const argumentsList = process.argv.slice(2);

function argument(name, fallback) {
  const index = argumentsList.indexOf(name);
  if (index < 0) return fallback;
  const value = argumentsList[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  return value;
}

const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "eval/fault-cases.json"), "utf8"),
);
if (manifest.format !== "pi-cloud.fault-eval.v1" || !Array.isArray(manifest.cases)) {
  throw new Error("Fault evaluation manifest is invalid");
}
const outputJson = resolve(
  repositoryRoot,
  argument("--output", "docs/reports/fault-eval-latest.json"),
);
const outputMarkdown = outputJson.replace(/\.json$/, ".md");

async function executeCase(faultCase) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-fault-"));
  const resultFile = join(temporary, "result.json");
  try {
    return await new Promise((resolvePromise) => {
      const startedAt = performance.now();
      const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const testPattern = [...(faultCase.setupTests ?? []), faultCase.test]
        .map(escapeRegularExpression)
        .join("|");
      const child = spawn(
        process.execPath,
        [
          resolve(repositoryRoot, "node_modules/vitest/vitest.mjs"),
          "run",
          resolve(
            repositoryRoot,
            "packages",
            faultCase.workspace.split("/").at(-1),
            faultCase.file,
          ),
          "-t",
          testPattern,
          "--reporter=json",
          "--outputFile",
          resultFile,
          "--maxWorkers=1",
          "--testTimeout=30000",
          "--hookTimeout=60000",
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      const collect = (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > 64_000) output = output.slice(-64_000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => {
        resolvePromise({
          id: faultCase.id,
          success: false,
          invariant: faultCase.invariant,
          durationMs: Math.round(performance.now() - startedAt),
          failure: error.message,
        });
      });
      child.once("exit", async (code, signal) => {
        let assertions = [];
        try {
          const report = JSON.parse(await readFile(resultFile, "utf8"));
          assertions = report.testResults.flatMap((file) => file.assertionResults);
        } catch {
          /* A missing/invalid test report is a failure, never a zero-test pass. */
        }
        const targets = assertions.filter((test) => test.title === faultCase.test);
        const targetExecuted =
          targets.length > 0 && targets.every((test) => test.status === "passed");
        const success = code === 0 && targetExecuted;
        resolvePromise({
          id: faultCase.id,
          success,
          invariant: faultCase.invariant,
          durationMs: Math.round(performance.now() - startedAt),
          ...(success
            ? {}
            : {
                failure: targetExecuted
                  ? `exit=${String(code)}, signal=${String(signal)}`
                  : `target test missing, skipped or failed: ${faultCase.test}`,
                outputTail: output.trim().slice(-4_000),
              }),
        });
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const results = [];
for (const faultCase of manifest.cases) {
  const result = await executeCase(faultCase);
  results.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const durations = results.map((result) => result.durationMs).sort((left, right) => left - right);
const percentile = (fraction) => durations[Math.max(0, Math.ceil(durations.length * fraction) - 1)];
const successful = results.filter((result) => result.success).length;
const report = {
  format: "pi-cloud.fault-eval-report.v1",
  piCloudRevision: testedRevision,
  generatedAt: new Date().toISOString(),
  methodology: "deterministic_targeted_fault_injection",
  liveChaosExperiment: false,
  caseCount: results.length,
  successful,
  successRate: results.length === 0 ? 0 : successful / results.length,
  p50DurationMs: percentile(0.5),
  p95DurationMs: percentile(0.95),
  results,
};
const markdown =
  `# PiCloud deterministic fault evaluation\n\n` +
  `Generated: ${report.generatedAt}\n\n` +
  `Revision: ${report.piCloudRevision}\n\n` +
  `These are targeted, deterministic fault injections against the durable execution protocol. ` +
  `They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.\n\n` +
  `- Cases: ${report.caseCount}\n` +
  `- Invariants preserved: ${report.successful}/${report.caseCount} (${(report.successRate * 100).toFixed(1)}%)\n` +
  `- p50 / p95: ${report.p50DurationMs} ms / ${report.p95DurationMs} ms\n\n` +
  `| Fault | Result | Protected invariant | Duration |\n` +
  `| --- | --- | --- | ---: |\n` +
  results
    .map(
      (result) =>
        `| ${result.id} | ${result.success ? "pass" : "fail"} | ${result.invariant} | ${result.durationMs} ms |`,
    )
    .join("\n") +
  `\n`;

await mkdir(dirname(outputJson), { recursive: true });
await writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(outputMarkdown, markdown, "utf8");
if (successful !== results.length) process.exitCode = 1;
