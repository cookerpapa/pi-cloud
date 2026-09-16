export const composeNetworks = {
  api: "pi-cloud-production_api",
  management: "pi-cloud-production_management",
  database: "pi-cloud-production_database",
  sandboxControl: "pi-cloud-production_sandbox-control",
  modelEgress: "pi-cloud-production_model-egress",
  observability: "pi-cloud-production_observability",
  eventLog: "pi-cloud-production_event-log",
};

export const bridgeTargets = [
  { name: "control-plane", network: composeNetworks.management, port: 3000 },
  { name: "tool-broker", network: composeNetworks.sandboxControl, port: 4300, workerAlias: true },
  { name: "provider-egress-relay", network: composeNetworks.modelEgress, port: 3129 },
  { name: "cli-proxy-api", network: composeNetworks.modelEgress, port: 8317 },
  { name: "postgres", network: composeNetworks.database, port: 5432 },
  ...[1, 2, 3].map((id) => ({
    name: `kafka-${id}`,
    network: composeNetworks.eventLog,
    port: 9092,
    workerAlias: true,
  })),
];

export function composeBridgeResources(targets, systemNamespace, workerNamespace) {
  return targets.flatMap((target) => [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: target.name,
        namespace: systemNamespace,
        labels: { "pi-cloud.io/bridge": "compose" },
      },
      spec: {
        ports: [{ name: "tcp", protocol: "TCP", port: target.port, targetPort: target.port }],
      },
    },
    {
      apiVersion: "discovery.k8s.io/v1",
      kind: "EndpointSlice",
      metadata: {
        name: `compose-${target.name}`,
        namespace: systemNamespace,
        labels: {
          "kubernetes.io/service-name": target.name,
          "endpointslice.kubernetes.io/managed-by": "pi-cloud-local-workers",
        },
      },
      addressType: "IPv4",
      endpoints: [{ addresses: [target.address], conditions: { ready: true } }],
      ports: [{ name: "tcp", protocol: "TCP", port: target.port }],
    },
    // Kafka returns these short hostnames in metadata after bootstrap. Broker
    // owner URLs also use the Compose name, so both must resolve in Worker Pods.
    ...(target.workerAlias
      ? [
          {
            apiVersion: "v1",
            kind: "Service",
            metadata: {
              name: target.name,
              namespace: workerNamespace,
              labels: { "pi-cloud.io/bridge": "compose-owner-alias" },
            },
            spec: {
              type: "ExternalName",
              externalName: `${target.name}.${systemNamespace}.svc.cluster.local`,
            },
          },
        ]
      : []),
  ]);
}

export function localWorkerValues(environment, systemNamespace) {
  const service = (name, port) => `http://${name}.${systemNamespace}.svc.cluster.local:${port}`;
  return {
    global: {
      kafka: {
        brokers: bridgeTargets
          .filter((target) => target.port === 9092)
          .map((target) => `${target.name}:9092`),
        partitions: Number(environment.PI_CLOUD_KAFKA_PARTITIONS ?? 32),
        replicas: 3,
        producerPendingBytes: Number(environment.PI_CLOUD_KAFKA_PRODUCER_PENDING_BYTES ?? 67108864),
        producerPendingFacts: Number(environment.PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS ?? 4096),
      },
    },
    services: {
      controlPlaneUrl: service("control-plane", 3000),
      toolBrokerUrls: [service("tool-broker", 4300)],
      providerProxyUrl: service("provider-egress-relay", 3129),
      providerGatewayUrl: service("cli-proxy-api", 8317),
    },
    workerPool: { capacity: Number(environment.PI_CLOUD_SUPERVISOR_CAPACITY ?? 4) },
    database: {
      maxConnections: Number(environment.PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS ?? 4),
    },
    runtime: {
      modelConcurrency: Number(environment.PI_CLOUD_WORKER_MODEL_CONCURRENCY ?? 4),
      sessionModelConcurrency: Number(environment.PI_CLOUD_SESSION_MODEL_CONCURRENCY ?? 4),
      subagents: {
        maximumDepth: Number(environment.PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH ?? 4),
        maximumNodes: Number(environment.PI_CLOUD_SUBAGENT_MAXIMUM_NODES ?? 32),
      },
    },
  };
}
