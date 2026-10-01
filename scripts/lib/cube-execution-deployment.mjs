import { createHash } from "node:crypto";

export function readyCubeletPod(pods) {
  return pods?.find(
    (pod) =>
      !pod.metadata?.deletionTimestamp &&
      pod.status?.containerStatuses?.some(
        (container) => container.name === "cubelet" && container.ready && container.state?.running,
      ),
  )?.metadata?.name;
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
export function cubeCompletionBridge(targets, namespace = "cube-system") {
  return targets.flatMap(({ name, address, port }) => {
    if (
      !/^[a-z0-9-]+$/.test(name) ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(address) ||
      !Number.isInteger(port)
    )
      throw new Error("Invalid Cube completion bridge endpoint");
    return [
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name, namespace, labels: { "pi-cloud.io/bridge": "completion" } },
        spec: { ports: [{ name: "tcp", protocol: "TCP", port, targetPort: port }] },
      },
      {
        apiVersion: "discovery.k8s.io/v1",
        kind: "EndpointSlice",
        metadata: {
          name: `picloud-completion-${name}`,
          namespace,
          labels: {
            "kubernetes.io/service-name": name,
            "endpointslice.kubernetes.io/managed-by": "pi-cloud-cube-completion",
          },
        },
        addressType: "IPv4",
        endpoints: [{ addresses: [address], conditions: { ready: true } }],
        ports: [{ name: "tcp", protocol: "TCP", port }],
      },
    ];
  });
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
