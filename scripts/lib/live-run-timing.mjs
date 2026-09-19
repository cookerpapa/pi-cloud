import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);

/** One-host deployment inventory for acceptance evidence, not runtime routing. */
export async function localWorkerTargets(options = {}) {
  const execute = options.execute ?? exec;
  const directory =
    options.runtimeDirectory ??
    resolve(
      fileURLToPath(new URL("../..", import.meta.url)),
      process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
    );
  const deployment =
    options.deployment ??
    (await readFile(resolve(directory, ".env"), "utf8")).match(
      /^PI_CLOUD_PI_WORKER_DEPLOYMENT=(.+)$/m,
    )?.[1] ??
    "compose";
  if (deployment === "kubernetes") {
    const prefix = [
      "--kubeconfig",
      resolve(directory, "kubernetes/pi-worker-local.kubeconfig"),
      "--namespace",
      "pi-cloud-workers",
    ];
    const { stdout } = await execute("kubectl", [
      ...prefix,
      "get",
      "pods",
      "--selector",
      "app.kubernetes.io/component=trusted-pi-worker",
      "--output",
      "json",
    ]);
    return JSON.parse(stdout).items.map((pod) => ({
      name: pod.metadata.name,
      image: pod.spec.containers.find((c) => c.name === "pi-worker").image,
      binary: "kubectl",
      execArgs: [...prefix, "exec", pod.metadata.name, "--container", "pi-worker", "--"],
      inspectArgs: [...prefix, "get", "pod", pod.metadata.name, "--output", "json"],
      logArgs: [...prefix, "logs", "--container", "pi-worker", pod.metadata.name],
      previous:
        (pod.status.containerStatuses?.find((c) => c.name === "pi-worker")?.restartCount ?? 0) > 0,
    }));
  }
  if (deployment !== "compose")
    throw new Error("Unsupported Worker deployment for acceptance logs");
  const { stdout } = await execute("docker", [
    "ps",
    "--all",
    "--filter",
    "label=com.docker.compose.project=pi-cloud-production",
    "--format",
    "{{.Names}} {{.Image}}",
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter((line) => /^pi-cloud-production-supervisor-host(?:-\d+)?-\d+ /.test(line))
    .map((line) => {
      const [name, image] = line.split(" ");
      return {
        name,
        image,
        binary: "docker",
        logArgs: ["logs", name],
        previous: false,
        execArgs: ["exec", name],
        inspectArgs: ["inspect", name],
      };
    });
}

/** Compare live process identities across a fault without confusing a retained Pod name with its process. */
export async function localWorkerProcesses(options = {}) {
  const execute = options.execute ?? exec;
  const processes = [];
  for (const target of await localWorkerTargets(options)) {
    const { stdout } = await execute(target.binary, target.inspectArgs);
    const state = JSON.parse(stdout);
    const container = target.binary === "docker" ? state[0] : undefined;
    const running =
      container?.State?.Running ??
      state.status?.containerStatuses?.find((c) => c.name === "pi-worker")?.state.running;
    if (!running) continue;
    const identity = container
      ? [container.Id, container.State.StartedAt]
      : [
          state.metadata.uid,
          state.status.containerStatuses.find((c) => c.name === "pi-worker").containerID,
          running.startedAt,
        ];
    processes.push({ ...target, identity });
  }
  return processes.sort((a, b) => a.name.localeCompare(b.name));
}

/** Public durable activity, not optimistic UI or streamed Tool argument JSON. */
export function isDurableAgentActivity(event) {
  return [
    "assistant.text.delta",
    "assistant.tool_call.preparing",
    "tool.started",
    "provider.hosted_tool.started",
  ].includes(event.type);
}

/** One-host acceptance helper. Only copy content-free transport records for the test Runs. */
export async function readWorkerModelTimings(runIds, sinceMs, options = {}) {
  const execute = options.execute ?? exec;
  const targets = await localWorkerTargets(options);
  const ids = new Set(runIds);
  const records = [];
  for (const target of targets) {
    for (const previous of target.previous ? [false, true] : [false]) {
      const output = await execute(
        target.binary,
        [
          ...target.logArgs,
          target.binary === "kubectl" ? "--since-time" : "--since",
          new Date(sinceMs - 1000).toISOString(),
          ...(previous ? ["--previous"] : []),
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      for (const line of (output.stdout + "\n" + output.stderr).split("\n")) {
        if (!line.startsWith('{"timestamp"') || !line.includes('"model.transport.timing"'))
          continue;
        const record = JSON.parse(line);
        if (record.event === "model.transport.timing" && ids.has(record.attributes.runId))
          records.push(record.attributes);
      }
    }
  }
  return records.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
}

/** Correlate the same first nonempty text; never subtract an entire model response from TTFT. */
export function runStageTiming(sample, requests) {
  const first = requests[0];
  if (
    !first ||
    sample.firstAssistantTextEmittedAtMs === undefined ||
    sample.firstAssistantTextMs === undefined
  )
    return undefined;
  if (sample.firstAssistantTextReceivedAtMs !== undefined) {
    const clockStepMs =
      sample.firstAssistantTextReceivedAtMs - sample.submittedWallAt - sample.firstAssistantTextMs;
    if (Math.abs(clockStepMs) > 100)
      return {
        unavailable:
          "Host wall clock changed during the Run; validate the monotonic clock independently before using durations",
        clockStepMs,
      };
  }
  const text = requests.findLast(
    (request) =>
      request.firstTextMs !== undefined &&
      request.receivedAtMs + request.firstTextMs <= sample.firstAssistantTextEmittedAtMs + 2,
  );
  if (!text) return undefined;
  const parsedAt = text.receivedAtMs + text.firstTextMs;
  const clientTextAt = sample.submittedWallAt + sample.firstAssistantTextMs;
  const round = (number) => Math.round(number * 1000) / 1000;
  const providerRouteToFirstTextMs = text.firstTextMs - text.upstreamStartMs;
  return {
    firstModelDispatchMs: round(
      first.receivedAtMs + first.upstreamStartMs - sample.submittedWallAt,
    ),
    providerRouteToFirstTextMs: round(providerRouteToFirstTextMs),
    parsedTextToPiEventMs: round(sample.firstAssistantTextEmittedAtMs - parsedAt),
    piEventToClientTextMs: round(clientTextAt - sample.firstAssistantTextEmittedAtMs),
    firstTextFollowsEarlierSampling: text !== first,
    ...(text === first
      ? { nonProviderTtftMs: round(sample.firstAssistantTextMs - providerRouteToFirstTextMs) }
      : {}),
    measurement:
      "API/SSE client receipt, not browser paint; provider route includes CLIProxyAPI; requires synchronized host clocks",
  };
}

/** Admitted-to-settled overlap, not an inference from simultaneous POSTs.
 * acceptedToAdmissionMs includes queueing and the admission transaction. */
export function maximumRunOverlap(evidence) {
  const boundaries = evidence
    .flatMap((row) => [
      { at: row.queuedWallAt + row.acceptedToAdmissionMs, delta: 1 },
      { at: row.queuedWallAt + row.serverElapsedMs, delta: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0,
    peak = 0;
  for (const boundary of boundaries) {
    active += boundary.delta;
    peak = Math.max(active, peak);
  }
  return peak;
}
