// Isolated diagnostic: ephemeral loopback gateway, injected upstream, no real credentials/models.
import assert from "node:assert/strict";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { TenantModelGateway } from "../packages/supervisor-host/src/model-gateway.ts";
import { modelSamplingHeaders } from "../packages/protocol/src/index.ts";

async function probe(revoke, count) {
  let upstreamCalls = 0;
  let checked = 0;
  let armed = false;
  const waiting = Promise.withResolvers();
  const gateway = new TenantModelGateway({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://127.0.0.1:1",
    providerGatewayBaseUrl: "http://injected-upstream.invalid",
    providerGatewayApiKey: "audit-local-fixture-not-a-real-key",
    maximumRequestsPerTurn: 1,
    clock: () => {
      if (armed && ++checked === count) waiting.resolve();
      return new Date();
    },
    fetchImplementation: async () => {
      upstreamCalls++;
      return new Response('data: {"type":"response.completed","response":{"id":"fixture"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await gateway.start();
  // issue() only uses these fields; this is not a forged public admission request.
  const lease = gateway.issue({
    payload: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      turnId: randomUUID(),
      runId: randomUUID(),
      model: {
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        profileId: randomUUID(),
        serviceTier: null,
      },
    },
  });
  const requests = [];
  try {
    armed = true;
    const responses = Array.from(
      { length: count },
      (_, i) =>
        new Promise((resolve, reject) => {
          const req = request(
            `http://127.0.0.1:${gateway.listeningPort}/v1/responses`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${lease.runtime.capability}`,
                "content-type": "application/json",
                ...modelSamplingHeaders({
                  stepSequence: i + 1,
                  stepSha256: "a".repeat(64),
                  samplingAttempt: 1,
                }),
              },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode));
            },
          );
          req.on("error", reject);
          req.setTimeout(5000, () => req.destroy(new Error("diagnostic request timeout")));
          requests.push(req);
          req.write('{"model":"deepseek-v4-pro",');
        }),
    );
    await waiting.promise;
    if (revoke) await lease.release();
    for (const req of requests) req.end('"stream":true,"input":[]}');
    const statuses = await Promise.all(responses);
    return {
      scenario: revoke ? "release-during-body-read" : "concurrent-request-limit",
      statuses,
      upstreamCalls,
    };
  } finally {
    for (const req of requests) req.destroy();
    await lease.release();
    await gateway.close();
  }
}

const release = await probe(true, 1);
const concurrent = await probe(false, 2);
console.log(JSON.stringify({ release, concurrent }, null, 2));
// Pins the observed defects at the reviewed revision, not the desired production behavior.
assert.equal(release.upstreamCalls, 1, "release race no longer reproduced; re-evaluate finding");
assert.equal(concurrent.upstreamCalls, 2, "limit race no longer reproduced; re-evaluate finding");
