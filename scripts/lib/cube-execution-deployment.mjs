import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** One matched native release; ordinary configuration reconciliation retains
 * installed image values unless an explicit new build is selected. */
export function cubeNativeImageArguments(tag) {
  if (tag === undefined) return [];
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
    throw new Error("Invalid native Cube image tag");
  return ["api", "master", "cubelet"].flatMap((component) => [
    "--set",
    `images.${component}.repository=pi-cloud/${component === "cubelet" ? "cubelet" : `cube-${component}`}`,
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

export const CUBE_COMPLETION_COMMAND = [
  "/usr/local/bin/node",
  "/opt/pi-cloud/node_modules/tsx/dist/cli.mjs",
  "/opt/pi-cloud/packages/cube-completion/src/main.ts",
];
export function withCubeExecutionCompletion(config) {
  const section = '[plugins."io.cubelet.cubebox-service.v1.cubebox-service"]';
  if (!config.includes(section))
    throw new Error("Cubelet service configuration section is missing");
  const lines = config
    .split("\n")
    .filter((line) => !/^\s*execution_completion_command\s*=/.test(line));
  return lines
    .join("\n")
    .replace(
      section,
      `${section}\n    execution_completion_command = ${JSON.stringify(CUBE_COMPLETION_COMMAND)}`,
    );
}
export function cubeCompletionSecret(files, namespace = "cube-system") {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "pi-cloud-cube-completion", namespace },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")]),
    ),
  };
}
export function cubeCompletionPatch(config) {
  const digest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return {
    spec: {
      template: {
        metadata: { annotations: { "pi-cloud.io/completion-configuration": digest } },
        spec: {
          containers: [
            {
              name: "cubelet",
              env: [
                {
                  name: "PI_CLOUD_DATABASE_URL_FILE",
                  value: "/run/pi-cloud-completion/database-url",
                },
                { name: "PI_CLOUD_KAFKA_BROKERS", value: config.kafkaBrokers.join(",") },
                { name: "PI_CLOUD_CONTROL_PLANE_URL", value: config.controlPlaneUrl },
                {
                  name: "PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE",
                  value: "/run/pi-cloud-completion/supervisor-management-token",
                },
                { name: "PI_CLOUD_IMAGE_S3_ENDPOINT", value: config.imageEndpoint },
                {
                  name: "PI_CLOUD_IMAGE_S3_CREDENTIALS_FILE",
                  value: "/run/pi-cloud-completion/session-image-s3-credentials.json",
                },
                { name: "PI_CLOUD_IMAGE_S3_REGION", value: config.imageRegion ?? "us-east-1" },
                {
                  name: "PI_CLOUD_IMAGE_S3_BUCKET",
                  value: config.imageBucket ?? "pi-cloud-session-images",
                },
              ],
              volumeMounts: [
                {
                  name: "pi-cloud-completion",
                  mountPath: "/run/pi-cloud-completion",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "pi-cloud-completion",
              secret: { secretName: "pi-cloud-cube-completion", defaultMode: 256 },
            },
          ],
        },
      },
    },
  };
}
