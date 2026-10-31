// Synthetic diagnostic overhead, not a PG/model or fleet throughput benchmark.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  measureRunPreparation,
  capturePreparationWork,
  PiCloudMetrics,
} from "../packages/observability/src/index.ts";
const mode = process.argv.find((value) => value.startsWith("--child="))?.split("=")[1];
const iterations = 10000,
  warmup = 1000;
if (mode) {
  const metrics = new PiCloudMetrics("preparation_benchmark");
  const operation = async () => {
    capturePreparationWork("storage_read")?.({ durationMs: 2, outcome: "completed" });
    capturePreparationWork("image_read")?.({
      durationMs: 1,
      outcome: "completed",
      byteLength: 1024,
    });
    return 42;
  };
  const run =
    mode === "timed"
      ? () =>
          measureRunPreparation("benchmark", "native_context_prepare", metrics, operation, {
            details: { conversationId: 1, taskId: 2, purpose: "agent" },
          })
      : operation;
  const flush = () =>
    new Promise((resolve, reject) =>
      process.stdout.write("", (error) => (error ? reject(error) : resolve())),
    );
  for (let i = 0; i < warmup; i++) await run();
  await flush();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) await run();
  await flush();
  process.stderr.write(
    JSON.stringify({
      kind: "preparation-benchmark",
      mode,
      iterations,
      warmup,
      durationMs: performance.now() - started,
    }) + "\n",
  );
} else {
  const execute = (mode) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", fileURLToPath(import.meta.url), `--child=${mode}`],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let bytes = 0,
        lines = 0,
        metadata = "";
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        for (const byte of chunk) if (byte === 10) lines++;
      });
      child.stderr.on("data", (chunk) => (metadata += chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) return reject(Error(`Benchmark failed: ${metadata.slice(-2000)}`));
        const value = metadata
          .split("\n")
          .filter((line) => line.startsWith('{"kind":"preparation-benchmark"'))
          .map((line) => JSON.parse(line))[0];
        if (!value) return reject(Error("Missing benchmark result"));
        resolve({
          ...value,
          bytes,
          lines,
          meanMicroseconds: (value.durationMs * 1000) / iterations,
        });
      });
    });
  const baseline = await execute("baseline"),
    timed = await execute("timed");
  console.log(
    JSON.stringify(
      {
        baseline,
        timed,
        incrementalMeanMicroseconds: timed.meanMicroseconds - baseline.meanMicroseconds,
        bytesPerRecord: timed.bytes / timed.lines,
        method:
          "synthetic stages, real JSON/metrics/stdout pipe drained by parent; excludes container logging and filesystem persistence; no payload inspection or PG/object-store/provider I/O",
      },
      null,
      2,
    ),
  );
}
