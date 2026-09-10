import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** One-host acceptance helper. Only copy content-free transport records for the test Runs. */
export async function readWorkerModelTimings(runIds, sinceMs) {
  const { stdout } = await exec("docker", [
    "ps",
    "--filter",
    "label=com.docker.compose.project=pi-cloud-production",
    "--format",
    "{{.Names}}",
  ]);
  const ids = new Set(runIds);
  const records = [];
  for (const container of stdout
    .trim()
    .split("\n")
    .filter((name) => /^pi-cloud-production-supervisor-host(?:-\d+)?-\d+$/.test(name))) {
    const output = await exec(
      "docker",
      ["logs", "--since", new Date(sinceMs - 1000).toISOString(), container],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    for (const line of (output.stdout + "\n" + output.stderr).split("\n")) {
      if (!line.startsWith('{"timestamp"') || !line.includes('"model.transport.timing"')) continue;
      const record = JSON.parse(line);
      if (record.event === "model.transport.timing" && ids.has(record.attributes.runId))
        records.push(record.attributes);
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
      "API/SSE client receipt, not browser paint; provider route includes CLIProxyAPI; synchronized host clocks",
  };
}

/** Claimed-to-settled overlap, not an inference from simultaneous POSTs. */
export function maximumRunOverlap(evidence) {
  const boundaries = evidence
    .flatMap((row) => [
      { at: row.queuedWallAt + row.queueWaitMs, delta: 1 },
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
