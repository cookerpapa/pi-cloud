import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { ResourceBackendRegistry } from "../../packages/sandbox-control/src/resource-backend-registry.ts";
import { DEVELOPMENT_ENVIRONMENT_PROFILES } from "../../packages/protocol/src/development-environment-profile.ts";

/** Only the deployment's original fixed Linux template is publication-owned. */
export function deploymentTemplateConfiguration(backend, template, allowedApiOrigins) {
  const current = backend.configuration;
  assert.equal(current.compute.provider, "cubesandbox");
  const endpoint = new URL(current.compute.apiUrl);
  assert(
    allowedApiOrigins.includes(endpoint.origin),
    "Primary backend is an independently managed cluster",
  );
  assert.equal(current.templates.length, 1, "Coordinate custom backend templates explicitly");
  const previous = current.templates[0];
  assert.equal(previous.id, "linux", "Primary template is not deployment-owned");
  assert.match(template.imageRevision, /^[a-f0-9]{40}$/);
  return {
    ...current,
    templates: [
      {
        ...previous,
        imageRevision: template.imageRevision,
        elasticTemplateId: template.agent.templateId,
        profiles: Object.fromEntries(
          DEVELOPMENT_ENVIRONMENT_PROFILES.map((profile) => [
            profile.key,
            template.development[profile.key].templateId,
          ]),
        ),
      },
    ],
  };
}

export async function reconcileDeploymentBackendTemplates({
  database,
  key,
  domainId,
  template,
  allowedApiOrigins,
  native,
}) {
  let expected;
  const registry = new ResourceBackendRegistry({
    database,
    key,
    managementBaseUrl: "http://control-plane:4300",
    verify: async (configuration) => {
      assert(
        expected && isDeepStrictEqual(configuration, expected),
        "Backend verification scope changed",
      );
      const first = configuration.templates[0];
      await native.verifyTemplate(first.elasticTemplateId);
      for (const profile of DEVELOPMENT_ENVIRONMENT_PROFILES) {
        const capacity = await native.verifyTemplate(first.profiles[profile.key]);
        assert.equal(capacity.cpuCount, profile.cpuCount);
        assert.equal(capacity.memoryMiB, profile.memoryMiB);
        assert.equal(capacity.systemDiskGiB, profile.systemDiskGiB);
      }
      assert(configuration.storage.poolId, "Retain the verified Workspace pool identity");
      return configuration.storage.poolId;
    },
  });
  const backend = (await registry.list()).find((value) => value.resource.id === domainId);
  if (!backend) return { adoptedOnStartup: true }; // First installation still owns its normal bootstrap.
  expected = deploymentTemplateConfiguration(backend, template, allowedApiOrigins);
  if (isDeepStrictEqual(expected, backend.configuration))
    return { changed: false, revision: backend.resource.revision };
  const { id, name, location, state, revision, computeBilling } = backend.resource;
  const result = await registry.put({
    id,
    name,
    location,
    state,
    computeBilling,
    expectedRevision: revision,
    configuration: expected,
  });
  return { changed: true, id, revision: result.revision, imageRevision: template.imageRevision };
}
