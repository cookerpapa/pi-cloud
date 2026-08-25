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
    throw new Error("global.imageRevision must be a full lowercase Git revision");
  }
  for (const name of ["controlPlane", "web", "toolBroker", "sshGateway"]) {
    deploymentString(values.images?.[name]?.repository, `images.${name}.repository`);
    deploymentString(values.images?.[name]?.tag, `images.${name}.tag`);
  }
  deploymentString(values["pi-workers"]?.image?.repository, "pi-workers.image.repository");
  deploymentString(values["pi-workers"]?.image?.tag, "pi-workers.image.tag");
  deploymentString(values.external?.providerProxyUrl, "external.providerProxyUrl");
  const servers = values.external?.jetstream?.servers;
  if (!Array.isArray(servers) || servers.length < 1) {
    throw new Error("JetStream servers are required");
  }
  for (const server of servers) deploymentString(server, "JetStream server");
  deploymentString(values.sandboxPlane?.cube?.apiUrl, "sandboxPlane.cube.apiUrl");
  const templateId = deploymentString(
    values.sandboxPlane?.cube?.templateId,
    "sandboxPlane.cube.templateId",
  );
  if (!/^tpl-[a-z0-9]{24}$/u.test(templateId)) {
    throw new Error("sandboxPlane.cube.templateId must be a Cube template ID");
  }

  const runtime = values["pi-workers"]?.runtime;
  const turnMs = integer(runtime?.timeouts?.turnMs, "Pi Worker Turn timeout");
  const toolBrokerRequestMs = integer(
    runtime?.timeouts?.toolBrokerRequestMs,
    "Pi Worker Tool Broker timeout",
  );
  const modelRequestMs = integer(runtime?.timeouts?.modelRequestMs, "Pi Worker model timeout");
  const upstreamMs = integer(
    runtime?.timeouts?.modelUpstreamRequestMs,
    "Pi Worker model upstream timeout",
  );
  const capabilityMs = integer(
    runtime?.timeouts?.modelCapabilityTtlMs,
    "Pi Worker model capability TTL",
  );
  if (upstreamMs > modelRequestMs || modelRequestMs > turnMs) {
    throw new Error("Model upstream, model request and Turn timeouts are not ordered");
  }
  if (capabilityMs < turnMs + 60_000) {
    throw new Error("Model capability TTL must outlive the Turn and expiry margin");
  }
  const terminationMs =
    integer(
      values["pi-workers"]?.lifecycle?.terminationGracePeriodSeconds,
      "Pi Worker termination grace",
    ) * 1_000;
  if (terminationMs < turnMs + toolBrokerRequestMs + 6 * 60_000) {
    throw new Error("Pi Worker termination grace is shorter than the Run drain budget");
  }
  const retentionMs = integer(
    values.external?.jetstream?.eventRetentionMs,
    "JetStream event retention",
  );
  if (retentionMs < turnMs + 5 * 60_000) {
    throw new Error("JetStream retention can omit a recoverable Run");
  }
  integer(
    values.controlPlane?.publicRegistration?.maximumConcurrentTurns,
    "public tenant concurrency",
  );
  integer(runtime?.subagents?.maximumConcurrent, "Subagent concurrency");
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
