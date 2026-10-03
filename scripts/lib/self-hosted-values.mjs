import { resolve } from "node:path";

export function selfHostedValues({ environment: e, runtime, cluster, template, images }) {
  const n = (key, fallback) => Number(e[key] ?? fallback);
  const quota = (key) =>
    e[key] === undefined || e[key] === "unlimited" || e[key] === "" ? null : Number(e[key]);
  const b = (key, fallback) => (e[key] ?? String(fallback)) === "true";
  const image = (key) => ({
    repository: images[key].slice(0, images[key].lastIndexOf(":")),
    tag: images[key].slice(images[key].lastIndexOf(":") + 1),
    pullPolicy: "IfNotPresent",
  });
  const nodeSelector = { "kubernetes.io/hostname": cluster.nodeName };
  const imageAttachments = { endpoint: "http://session-images:8333" };
  const publicUrl =
    e.PI_CLOUD_PUBLIC_ORIGIN_BASE_URL ?? `http://127.0.0.1:${n("PI_CLOUD_HTTP_PORT", 8080)}`;
  return {
    infrastructure: {
      observability: { enabled: e.PI_CLOUD_OBSERVABILITY_ENABLED === "1" },
      nodeName: cluster.nodeName,
      storageRoot: e.PI_CLOUD_K3S_STORAGE_ROOT ?? "/var/lib/pi-cloud",
      workspacePath: resolve(runtime, "state/cube-shared/volume"),
      providerStatePath: resolve(runtime, "state/cli-proxy"),
      providerConfigPath: resolve(runtime, "secrets/cli-proxy-config.yaml"),
      relaySocketPath: resolve(runtime, "state/provider-relay"),
      provider: {
        uid: n("PI_CLOUD_APPLICATION_UID", 1000),
        gid: n("PI_CLOUD_APPLICATION_GID", 1000),
        image: images.provider,
        relayImage: images.relay,
        upstreamProxy: e.PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY ?? "",
      },
    },
    platform: {
      profile: "self-hosted",
      global: {
        imageRevision: template.imageRevision,
        trustedNodeSelector: nodeSelector,
        kafka: {
          brokers: ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
          partitions: n("PI_CLOUD_KAFKA_PARTITIONS", 32),
          replicas: 3,
          producerPendingBytes: n("PI_CLOUD_KAFKA_PRODUCER_PENDING_BYTES", 67108864),
          producerPendingFacts: n("PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS", 4096),
          acceptedFactRetentionMs: n("PI_CLOUD_ACCEPTED_FACT_RETENTION_MS", 7200000),
        },
      },
      images: {
        controlPlane: image("controlPlane"),
        web: image("web"),
        workspaceVolumeGateway: image("volumeGateway"),
        sshGateway: image("sshGateway"),
      },
      bootstrap: {
        tenantId: e.PI_CLOUD_TENANT_ID,
        tenantSlug: e.PI_CLOUD_TENANT_SLUG,
        userId: e.PI_CLOUD_USER_ID,
        apiCredentialId: e.PI_CLOUD_API_CREDENTIAL_ID,
        credentialBindingId: e.PI_CLOUD_CREDENTIAL_BINDING_ID,
        defaultModelProfileId: e.PI_CLOUD_DEFAULT_MODEL_PROFILE_ID,
        maximumProjects: quota("PI_CLOUD_TENANT_MAXIMUM_PROJECTS"),
        maximumSessions: quota("PI_CLOUD_TENANT_MAXIMUM_SESSIONS"),
      },
      controlPlane: {
        replicas: 1,
        autoscaling: { enabled: false },
        supervisorIdPrefix: "pi-cloud-pi-worker-",
        platformModelSourceTenantId: e.PI_CLOUD_PLATFORM_MODEL_SOURCE_TENANT_ID,
        platformOperatorTenantId: e.PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID ?? "",
        publicOriginBaseUrl: publicUrl,
        previewOriginBaseUrl:
          e.PI_CLOUD_PREVIEW_ORIGIN_BASE_URL ??
          `http://preview.localhost:${n("PI_CLOUD_HTTP_PORT", 8080)}`,
        cookieSecure: b("PI_CLOUD_WEB_SESSION_COOKIE_SECURE", false),
        noProxy:
          "127.0.0.1,localhost,postgres,session-images,control-plane,workspace-volume-gateway,cube-api,cube-proxy,cli-proxy-api,gitlab.internal,.svc,.cluster.local,10.42.0.0/16,10.43.0.0/16,10.255.255.254",
        publicRegistration: {
          enabled: b("PI_CLOUD_PUBLIC_REGISTRATION_ENABLED", true),
          maximumTenants: quota("PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS"),
          maximumProjects: quota("PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS"),
          maximumSessions: quota("PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS"),
        },
        sourceControl: {
          github: {
            enabled: Boolean(e.PI_CLOUD_GITHUB_APP_ID),
            appId: e.PI_CLOUD_GITHUB_APP_ID ?? "",
          },
          gitlab: {
            enabled: b("PI_CLOUD_GITLAB_ENABLED", false),
            webhookUrl:
              e.PI_CLOUD_GITLAB_WEBHOOK_URL ?? `${publicUrl}/v1/source-control/gitlab/webhook`,
            internalBaseUrl: e.PI_CLOUD_GITLAB_INTERNAL_BASE_URL ?? "",
            workspaceBaseUrl: e.PI_CLOUD_GITLAB_WORKSPACE_BASE_URL ?? "",
          },
        },
        resources: {
          requests: { cpu: "100m", memory: "384Mi" },
        },
      },
      web: {
        resources: { requests: { cpu: "50m", memory: "64Mi" } },
        replicas: 1,
        autoscaling: { enabled: false },
        adminOriginBaseUrl:
          e.PI_CLOUD_ADMIN_ORIGIN_BASE_URL ?? `http://127.0.0.1:${n("PI_CLOUD_ADMIN_PORT", 8081)}`,
        hostIP: e.PI_CLOUD_HTTP_BIND_ADDRESS ?? "127.0.0.1",
        adminHostIP: e.PI_CLOUD_ADMIN_BIND_ADDRESS ?? "127.0.0.1",
        hostPorts: {
          http: n("PI_CLOUD_HTTP_PORT", 8080),
          admin: n("PI_CLOUD_ADMIN_PORT", 8081),
          provider: n("PI_CLOUD_CLI_PROXY_MANAGEMENT_PORT", 8318),
        },
        managementUrls: {
          providerGateway:
            e.PI_CLOUD_PROVIDER_MANAGEMENT_URL ??
            `http://127.0.0.1:${n("PI_CLOUD_CLI_PROXY_MANAGEMENT_PORT", 8318)}/management.html`,
        },
      },
      sshGateway: {
        resources: { requests: { cpu: "50m", memory: "64Mi" } },
        replicas: 1,
        serviceType: "ClusterIP",
        advertisedHost: e.PI_CLOUD_SSH_ADVERTISED_HOST ?? "127.0.0.1",
        hostIP: e.PI_CLOUD_SSH_BIND_ADDRESS ?? "127.0.0.1",
        hostPort: n("PI_CLOUD_SSH_PORT", 2222),
        port: n("PI_CLOUD_SSH_PORT", 2222),
      },
      external: {
        providerProxyUrl: "http://provider-egress-relay:3129",
        otlpTracesEndpoint:
          e.PI_CLOUD_OBSERVABILITY_ENABLED === "1" ? "http://jaeger:4318/v1/traces" : "",
      },
      // Cube's direct node APIs and local provider relay keep their existing private-node boundary.
      networkPolicy: {
        trustedTcpPorts: [
          80, 8333, 8317, 443, 3000, 3001, 3129, 4100, 4300, 4318, 4500, 5432, 9092, 9464, 9465,
          9466, 8089, 12345, 12346,
        ],
        externalEgressCidrs: [`${cluster.nodeAddress ?? "10.255.255.254"}/32`],
      },
      sandboxPlane: {
        volumeGatewayResources: { requests: { cpu: "250m", memory: "256Mi" } },
        volumeGatewayReplicas: 1,
        workspace: { existingClaim: "pi-cloud-workspaces" },
        maximumActivePerReplica: quota("PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES"),
        maximumActiveCommands: n("PI_CLOUD_TOOL_MAXIMUM_ACTIVE_COMMANDS", 8),
        maximumWarmWorkspaceRuntimesPerReplica: n("PI_CLOUD_MAXIMUM_WARM_WORKSPACE_RUNTIMES", 4),
        cube: {
          apiUrl: "http://cube-api:3000",
          proxyNodeIp: "cube-proxy",
          proxyPort: 80,
          proxyScheme: "http",
          domain: cluster.sandboxDomain,
          templateId: template.agent.templateId,
          developmentTemplateIds: Object.fromEntries(
            Object.entries(template.development).map(([key, value]) => [key, value.templateId]),
          ),
          directPrivateCidrs: (e.PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS ?? "")
            .split(",")
            .filter(Boolean),
        },
      },
      imageAttachments,
      "pi-workers": {
        resources: {
          requests: { cpu: "250m", memory: "384Mi" },
        },
        workerPool: { replicas: 2, capacity: quota("PI_CLOUD_SUPERVISOR_CAPACITY") },
        autoscaling: { enabled: false },
        image: image("worker"),
        services: {
          otlpTracesEndpoint:
            e.PI_CLOUD_OBSERVABILITY_ENABLED === "1" ? "http://jaeger:4318/v1/traces" : "",
          controlPlaneUrl: "http://control-plane:3000",
          providerProxyUrl: "http://provider-egress-relay:3129",
          providerGatewayUrl: "http://cli-proxy-api:8317",
        },
        state: { storageClassName: "local-path", accessModes: ["ReadWriteOnce"] },
        placement: { nodeSelector },
        imageAttachments,
        database: { maxConnections: n("PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS", 4) },
        runtime: {
          subagents: {
            maximumDepth: quota("PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH"),
            maximumNodes: quota("PI_CLOUD_SUBAGENT_MAXIMUM_NODES"),
          },
          modelConcurrency: quota("PI_CLOUD_WORKER_MODEL_CONCURRENCY"),
          sessionModelConcurrency: quota("PI_CLOUD_SESSION_MODEL_CONCURRENCY"),
        },
        networkPolicy: { externalEgressCidrs: [] },
      },
    },
  };
}
