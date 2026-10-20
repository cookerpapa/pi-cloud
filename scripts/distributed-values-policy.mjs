function required(value, description) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${description} is required`);
  }
  return value;
}

function integer(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${description} is invalid`);
  return value;
}

function deploymentString(value, description) {
  const text = String(required(value, description));
  if (/example\.(?:com|internal)|git-sha-|0123456789abcdef|development/u.test(text)) {
    throw new Error(`${description} still contains an example placeholder`);
  }
  return text;
}

export function validateDistributedDeploymentValues(values) {
  const revision = deploymentString(values.global?.imageRevision, "global.imageRevision");
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("global.imageRevision must be a 40-hex guest build identity");
  }
  for (const name of ["controlPlane", "web", "workspaceVolumeGateway", "sshGateway"]) {
    deploymentString(values.images?.[name]?.repository, `images.${name}.repository`);
    deploymentString(values.images?.[name]?.tag, `images.${name}.tag`);
  }
  deploymentString(values["pi-workers"]?.image?.repository, "pi-workers.image.repository");
  deploymentString(values["pi-workers"]?.image?.tag, "pi-workers.image.tag");
  deploymentString(values.external?.providerProxyUrl, "external.providerProxyUrl");
  const servers = values.global?.kafka?.brokers;
  if (!Array.isArray(servers) || servers.length < 1) {
    throw new Error("Kafka brokers are required");
  }
  for (const server of servers) deploymentString(server, "Kafka broker");
  deploymentString(values.sandboxPlane?.cube?.apiUrl, "sandboxPlane.cube.apiUrl");
  const templateId = deploymentString(
    values.sandboxPlane?.cube?.templateId,
    "sandboxPlane.cube.templateId",
  );
  if (!/^tpl-[a-z0-9]{24}$/u.test(templateId)) {
    throw new Error("sandboxPlane.cube.templateId must be a Cube template ID");
  }

  const runtime = values["pi-workers"]?.runtime;
  const drainMs = integer(runtime?.timeouts?.workerDrainMs, "Pi Worker drain grace");
  const retirementMs = integer(
    runtime?.timeouts?.workerRetirementMs,
    "Pi Worker retirement timeout",
  );
  const sandboxControlRequestMs = integer(
    runtime?.timeouts?.sandboxControlRequestMs,
    "Pi Worker Sandbox control timeout",
  );
  const modelRequestMs = integer(runtime?.timeouts?.modelRequestMs, "Pi Worker model timeout");
  const upstreamConnectMs = integer(
    runtime?.timeouts?.modelUpstreamConnectMs,
    "Pi Worker model upstream connect timeout",
  );
  integer(runtime?.timeouts?.modelUpstreamIdleMs, "Pi Worker model upstream idle timeout");
  if (upstreamConnectMs > modelRequestMs) {
    throw new Error("Model response-header waits are not ordered");
  }
  if (retirementMs < sandboxControlRequestMs + 5 * 60_000) {
    throw new Error("Pi Worker retirement cannot cover operation cleanup and settlement");
  }
  const terminationMs =
    integer(
      values["pi-workers"]?.lifecycle?.terminationGracePeriodSeconds,
      "Pi Worker termination grace",
    ) * 1_000;
  if (terminationMs < drainMs + retirementMs + 60_000) {
    throw new Error("Pi Worker termination grace is shorter than its retirement budget");
  }
  integer(values.global?.kafka?.acceptedFactRetentionMs, "Kafka AcceptedFact retention");
  const models =
    runtime?.modelConcurrency == null
      ? null
      : integer(runtime.modelConcurrency, "Worker model concurrency");
  const sessionModels =
    runtime?.sessionModelConcurrency == null
      ? null
      : integer(runtime.sessionModelConcurrency, "Session model concurrency");
  if (sessionModels !== null && models !== null && sessionModels > models)
    throw new Error("Session model concurrency cannot exceed the Worker model limit");
  if (runtime?.subagents?.maximumConcurrent !== undefined)
    throw new Error("Remove retired Subagent slot reservation");
  const queueWaitMs = integer(
    values.sandboxPlane?.volumeGatewayQueueWaitTimeoutMs,
    "Volume Gateway queue wait",
  );
  const requestMs = integer(
    values.sandboxPlane?.volumeGatewayRequestTimeoutMs,
    "Volume Gateway request timeout",
  );
  if (queueWaitMs >= requestMs) {
    throw new Error("Volume Gateway queue wait must be shorter than request timeout");
  }
}
