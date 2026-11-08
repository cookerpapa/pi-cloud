import { Agent, fetch as internalFetch } from "undici";
import { setTimeout as delay } from "node:timers/promises";

/** Kubernetes readiness can precede the first native CubeOps heartbeat. This
 * gate permits an attempt to build; it never proves absence or releases quota. */
export async function waitForCubeNodeReadiness({
  kubectl,
  timeoutMs = 180_000,
  request = internalFetch,
  pause = delay,
  now = Date.now,
}) {
  const dispatcher = new Agent();
  const deadline = now() + timeoutMs;
  let confirmed = "",
    consecutive = 0,
    lastError;
  try {
    while (now() < deadline) {
      try {
        const pods = JSON.parse(await kubectl(["get", "pods", "-o", "json"])).items.filter(
          (p) =>
            !p.metadata.deletionTimestamp && p.spec.containers.some((c) => c.name === "cubelet"),
        );
        const service = JSON.parse(await kubectl(["get", "service", "cube-ops", "-o", "json"]));
        const port = service.spec.ports.find((p) => p.name === "http" || p.port === 3010)?.port;
        if (!port || !service.spec.clusterIP || service.spec.clusterIP === "None")
          throw new Error("CubeOps endpoint is unavailable");
        const host = service.spec.clusterIP.includes(":")
          ? `[${service.spec.clusterIP}]`
          : service.spec.clusterIP;
        const response = await request(`http://${host}:${port}/internal/v1/nodes`, {
          dispatcher,
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("CubeOps node view is unavailable");
        const nodes = await response.json();
        if (!Array.isArray(nodes)) throw new Error("CubeOps node view changed shape");
        const ready =
          pods.length > 0 &&
          pods.every(
            (p) =>
              p.status.podIP &&
              p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True") &&
              nodes.some(
                (n) =>
                  n.IP === p.status.podIP &&
                  n.Healthy === true &&
                  n.ReportedReady === true &&
                  Date.parse(n.MetricUpdateAt) >= Date.parse(p.status.startTime),
              ),
          );
        const identity = JSON.stringify(pods.map((p) => p.metadata.uid).sort());
        consecutive = ready ? (identity === confirmed ? consecutive + 1 : 1) : 0;
        confirmed = ready ? identity : "";
        if (consecutive >= 2) return { nodes: pods.length };
      } catch (error) {
        lastError = error;
        consecutive = 0;
      }
      await pause(1000);
    }
    throw new Error("Native Cube nodes did not become ready for template creation", {
      cause: lastError,
    });
  } finally {
    await dispatcher.close();
  }
}
