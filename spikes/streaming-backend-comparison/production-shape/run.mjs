import { execFileSync, fork } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));
const benchmark = fileURLToPath(new URL("benchmark.mjs", import.meta.url));
const authorityBatchBenchmark = fileURLToPath(
  new URL("authority-batch-benchmark.ts", import.meta.url),
);
const reports = fileURLToPath(new URL("../../../docs/reports", import.meta.url));

function compose(argumentsList, quiet = false) {
  execFileSync("docker", ["compose", "-f", composeFile, ...argumentsList], {
    cwd: directory,
    stdio: quiet ? "ignore" : "inherit",
  });
}

function markdown(report) {
  const stages = report.sseScale.stages
    .map(
      (stage) =>
        `| ${stage.connections} | ${stage.connectLatencyMs.p95} ms | ${stage.gatewayRssMiB} MiB | ${stage.jetStreamConsumers} | ${stage.hostFreeMemoryGiB} GiB |`,
    )
    .join("\n");
  return (
    `# JetStream production-shape acceptance\n\n` +
    `Generated: ${report.generatedAt}\n\n` +
    `Revision: \`${report.revision}\`\n\n` +
    `- Stream: R=${report.stream.replicas}, ${report.stream.storage}\n` +
    `- Baseline ordered/durable projection: ${report.baseline.ordered ? "passed" : "failed"}\n` +
    `- Stale ExecutionGrant rejected: ${report.authorityGrant.stalePublishRejected ? "yes" : "no"}\n` +
    `- Gateway replay after loss: ${report.gatewayRecovery.ordered ? "passed" : "failed"}\n` +
    `- Projector commit-before-ACK redelivery: ${report.projectorRecovery.idempotent ? "idempotent" : "failed"}\n` +
    `- Stream leader loss delivery: ${report.leaderRecovery.delivered ? "passed" : "failed"} (${report.leaderRecovery.publishAndDeliveryMs} ms)\n` +
    `- Authority batching: ${report.authorityBatchThroughput.baseline.eventsPerSecond} → ${report.authorityBatchThroughput.batched.eventsPerSecond} events/s (${report.authorityBatchThroughput.speedup}x)\n` +
    `- PostgreSQL authority statements: ${report.authorityBatchThroughput.baseline.authorityStatements} for ${report.authorityBatchThroughput.baseline.events} events → ${report.authorityBatchThroughput.batched.authorityStatements} for ${report.authorityBatchThroughput.batched.events} events\n` +
    `- SSE first-connection delivery: ${report.sseScale.deliveredConnections}/${report.sseScale.targetConnections}\n` +
    `- SSE effective delivery after reconnect: ${report.sseScale.effectiveDeliveredConnections}/${report.sseScale.targetConnections}\n\n` +
    `- Publish phase: ${report.sseScale.publishElapsedMs} ms; browser read phase: ${report.sseScale.browserReadElapsedMs} ms\n\n` +
    `| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |\n` +
    `| ---: | ---: | ---: | ---: | ---: |\n${stages}\n`
  );
}

compose(["down", "--volumes", "--remove-orphans"], true);
try {
  compose(["up", "--detach", "--wait"]);
  const report = await new Promise((resolve, reject) => {
    let result;
    const child = fork(benchmark, [], {
      cwd: directory,
      env: process.env,
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.once("message", (value) => {
      result = value;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || result === undefined) {
        reject(
          new Error(
            `JetStream production-shape benchmark failed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
  report.authorityBatchThroughput = await new Promise((resolve, reject) => {
    let result;
    const child = fork(authorityBatchBenchmark, [], {
      cwd: directory,
      env: process.env,
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.once("message", (value) => {
      result = value;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || result === undefined) {
        reject(
          new Error(
            `JetStream authority-batch benchmark failed (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
  await mkdir(reports, { recursive: true });
  const json = `${reports}/jetstream-production-shape-latest.json`;
  const md = `${reports}/jetstream-production-shape-latest.md`;
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(md, markdown(report), "utf8");
  execFileSync(process.execPath, [
    `${repositoryRoot}/node_modules/prettier/bin/prettier.cjs`,
    "--write",
    json,
    md,
  ]);
} finally {
  compose(["down", "--volumes", "--remove-orphans"], true);
}
