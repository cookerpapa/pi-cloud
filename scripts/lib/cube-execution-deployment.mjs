import { setTimeout as delay } from "node:timers/promises";

/** One matched native release; ordinary configuration reconciliation retains
 * installed image values unless an explicit new build is selected. */
export function cubeNativeImageArguments(tag) {
  if (tag === undefined) return [];
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
    throw new Error("Invalid native Cube image tag");
  return [
    ["api", "cube-api"],
    ["master", "cube-master"],
    ["cubelet", "cubelet"],
    ["templateCenter", "cube-templatecenter"],
  ].flatMap(([component, image]) => [
    "--set",
    `images.${component}.repository=pi-cloud/${image}`,
    "--set",
    `images.${component}.tag=${tag}`,
  ]);
}

export function readyCubeletPod(pods, expectedImage) {
  return pods?.find(
    (pod) =>
      !pod.metadata?.deletionTimestamp &&
      (!expectedImage ||
        pod.spec?.containers?.some((c) => c.name === "cubelet" && c.image === expectedImage)) &&
      pod.status?.containerStatuses?.some(
        (container) =>
          container.name === "cubelet" &&
          container.ready &&
          container.state?.running &&
          (!expectedImage ||
            container.image === expectedImage ||
            container.image?.endsWith(`/${expectedImage}`)),
      ),
  )?.metadata?.name;
}

/** Wait for the requested release, never a healthy predecessor being replaced. */
export async function waitForReadyCubelet({
  readPods,
  expectedImage,
  timeoutMs = 180_000,
  now = Date.now,
  sleep = delay,
}) {
  if (!expectedImage || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Cubelet readiness target is invalid");
  const deadline = now() + timeoutMs;
  for (;;) {
    const pod = readyCubeletPod(await readPods(), expectedImage);
    if (pod) return pod;
    if (now() >= deadline) throw new Error(`Cubelet did not become ready for ${expectedImage}`);
    await sleep(Math.min(1000, deadline - now()));
  }
}
