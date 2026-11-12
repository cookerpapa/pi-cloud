import assert from "node:assert/strict";

/** Fixture selection is explicit; never globally switch another user's provider. */
export async function registeredBackend(api, provider, id = process.env.PI_CLOUD_LIVE_BACKEND_ID) {
  const available = (await api.resourceBackends()).backends.filter(
    (backend) => backend.provider === provider && (!id || backend.id === id),
  );
  assert.equal(
    available.length,
    1,
    "Select one active registered backend with PI_CLOUD_LIVE_BACKEND_ID",
  );
  const backend = available[0];
  assert(backend.templates.length, "Backend has no supported environment template");
  return { id: backend.id, revision: backend.revision, templateId: backend.templates[0].id };
}
