import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Check the actual caller route; Pod readiness and operator access miss egress policy failures. */
export async function verifyToolHostRouteInCluster({ kubectl, release = "pi-cloud", releaseId }) {
  const pods = JSON.parse(
    await kubectl([
      "get",
      "pods",
      "-l",
      `app.kubernetes.io/instance=${release},app.kubernetes.io/component=session-runtime`,
      "-o",
      "json",
    ]),
  ).items.filter((p) => !p.metadata.deletionTimestamp && p.status.phase === "Running");
  assert(pods.length, "No Session runtime can verify the ordinary Tool route");
  for (const pod of pods) {
    const code = `import {readFileSync} from 'node:fs';import {Agent,fetch} from 'undici';
const dispatcher=new Agent();try {
const token=readFileSync(process.env.PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE,'utf8').trim();
const r=await fetch('http://tool-host:4310/internal/v1/tools/manifest',{dispatcher,headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
if(!r.ok)throw Error('Tool route unavailable');const m=await r.json();
console.log(JSON.stringify({releaseId:m.releaseId,generation:m.selected?.generation,revision:m.catalog?.revision}));
}finally{await dispatcher.close();}`;
    const result = JSON.parse(
      await kubectl([
        "exec",
        pod.metadata.name,
        "-c",
        "session-runtime",
        "--",
        "node",
        "--input-type=module",
        "-e",
        code,
      ]),
    );
    assert.equal(
      result.releaseId,
      releaseId,
      "Session runtime reached another Tool implementation",
    );
    assert(Number.isSafeInteger(result.generation) && result.generation > 0);
  }
  return { verified: true, sessionRuntimes: pods.length };
}

/** Activation is an explicit deploy step, not an old executable electing itself.
 * A lost HTTP reply is reconciled against the selected release/generation. */
export async function activateToolHost({
  pods,
  token,
  expectedImage,
  request = fetch,
  pause = delay,
  timeoutMs = 180_000,
}) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    for (const pod of await pods()) {
      if (
        pod.metadata.deletionTimestamp ||
        !pod.status.podIP ||
        pod.status.phase !== "Running" ||
        !pod.spec.containers.some((c) => c.name === "tool-host" && c.image === expectedImage)
      )
        continue;
      const base = `http://${pod.status.podIP}:4310/internal/v1/tools`;
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      try {
        const response = await request(`${base}/manifest`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("Tool host manifest is unavailable");
        const manifest = await response.json();
        assert.equal(typeof manifest.releaseId, "string");
        assert.equal(typeof manifest.catalog?.revision, "string");
        const activation = await request(`${base}/activate`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            releaseId: manifest.releaseId,
            revision: manifest.catalog.revision,
            expectedGeneration: manifest.selected?.generation ?? 0,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!activation.ok) throw new Error("Tool catalog activation is pending");
        const value = await activation.json();
        assert.equal(value.revision, manifest.catalog.revision);
        assert(Number.isSafeInteger(value.generation) && value.generation > 0);
        return { releaseId: manifest.releaseId, ...value };
      } catch (error) {
        lastError = error;
      }
    }
    await pause(500);
  }
  throw new Error("Tool host activation did not converge; retain deployment evidence", {
    cause: lastError,
  });
}

/** Distributed operators need not reach Pod IPs or export a management token. */
export async function activateToolHostInCluster({ kubectl, release, timeoutMs = 180_000 }) {
  const until = Date.now() + timeoutMs;
  let failure;
  while (Date.now() < until) {
    const deployment = JSON.parse(
      await kubectl(["get", `deployment/${release}-tool-host`, "-o", "json"]),
    );
    const image = deployment.spec.template.spec.containers.find(
      (c) => c.name === "tool-host",
    ).image;
    const pods = JSON.parse(
      await kubectl([
        "get",
        "pods",
        "-l",
        `app.kubernetes.io/instance=${release},app.kubernetes.io/component=tool-host`,
        "-o",
        "json",
      ]),
    ).items;
    const pod = pods.find(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.status.phase === "Running" &&
        p.spec.containers.some((c) => c.name === "tool-host" && c.image === image),
    );
    if (pod)
      try {
        const code = `const fs=require('node:fs');(async()=>{
        const token=fs.readFileSync(process.env.PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE,'utf8').trim();
        const headers={authorization:'Bearer '+token,'content-type':'application/json'};
        const base='http://127.0.0.1:4310/internal/v1/tools';
        const m=await fetch(base+'/manifest',{headers,signal:AbortSignal.timeout(5000)});
        if(!m.ok)throw Error('manifest unavailable');const v=await m.json();
        if(v.executableId!==process.env.PI_CLOUD_TOOL_RELEASE_ID)throw Error('release changed');
        const r=await fetch(base+'/activate',{method:'POST',headers,signal:AbortSignal.timeout(20000),
          body:JSON.stringify({releaseId:v.releaseId,revision:v.catalog.revision,expectedGeneration:v.selected?.generation??0})});
        if(!r.ok)throw Error('activation unconfirmed');console.log(JSON.stringify(await r.json()));
      })().catch(()=>{console.error('Tool catalog activation pending');process.exitCode=1;});`;
        const result = JSON.parse(
          await kubectl(["exec", pod.metadata.name, "-c", "tool-host", "--", "node", "-e", code]),
        );
        assert(Number.isSafeInteger(result.generation) && result.generation > 0);
        return result;
      } catch (error) {
        failure = error;
      }
    await delay(1000);
  }
  throw new Error("Distributed tool catalog activation did not converge", { cause: failure });
}
