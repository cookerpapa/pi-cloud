import { execFileSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const spikeDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));
const benchmark = fileURLToPath(new URL("benchmark.mjs", import.meta.url));
const reportDirectory = fileURLToPath(new URL("../../docs/reports", import.meta.url));

function compose(argumentsList, options = {}) {
  execFileSync("docker", ["compose", "-f", composeFile, ...argumentsList], {
    cwd: spikeDirectory,
    stdio: options.quiet ? "ignore" : "inherit",
  });
}

function markdown(report) {
  const rows = report.results
    .map(
      (result) =>
        `| ${result.backend} | ${result.publish.eventsPerSecond.toLocaleString("en-US")}/s | ${result.publish.acknowledgementLatencyMs.p95} ms | ${result.globalProjection.deliveryLatencyMs.p95} ms | ${result.focusedReplay.scanAmplification}x | ${result.processKillRecovery.acknowledgedSentinelRecovered ? "yes" : "no"} |`,
    )
    .join("\n");
  return (
    `# Streaming backend comparison\n\n` +
    `Generated: ${report.generatedAt}\n\n` +
    `Revision: \`${report.revision}\`\n\n` +
    `Workload: ${report.workload.sessionCount} Sessions × ${report.workload.eventsPerSession} events, ${report.workload.payloadBytes}-byte target payload, isolated single-node brokers.\n\n` +
    `| Backend | Acked publish | Ack p95 | Projection p95 | Focused replay scan | ACKed sentinel after process kill |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
    `## Gateway state\n\n` +
    report.results.map((result) => `- **${result.backend}:** ${result.gatewayState}`).join("\n") +
    `\n\n## ${report.workload.idleReaders} idle Gateway readers\n\n` +
    report.results
      .map(
        (result) =>
          `- **${result.backend}:** ${result.idleGatewayReaders.brokerResources} ${result.idleGatewayReaders.resourceUnit}; setup ${result.idleGatewayReaders.setupElapsedMs} ms. ${result.idleGatewayReaders.note}`,
      )
      .join("\n") +
    `\n\n## Guardrails\n\n` +
    report.interpretationGuardrails.map((item) => `- ${item}`).join("\n") +
    `\n`
  );
}

compose(["down", "--volumes", "--remove-orphans"], { quiet: true });
try {
  compose(["up", "--detach", "--wait"]);
  const report = await new Promise((resolve, reject) => {
    let received = false;
    const child = fork(benchmark, [], {
      cwd: repositoryRoot,
      env: process.env,
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.once("message", (value) => {
      received = true;
      resolve(value);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || !received) {
        reject(
          new Error(`Streaming benchmark failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
  });
  await mkdir(reportDirectory, { recursive: true });
  const jsonPath = `${reportDirectory}/streaming-backend-comparison-latest.json`;
  const markdownPath = `${reportDirectory}/streaming-backend-comparison-latest.md`;
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown(report), "utf8");
  execFileSync(process.execPath, [
    `${repositoryRoot}/node_modules/prettier/bin/prettier.cjs`,
    "--write",
    jsonPath,
    markdownPath,
  ]);
} finally {
  compose(["down", "--volumes", "--remove-orphans"], { quiet: true });
}
