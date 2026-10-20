import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { kubectl } from "./production-kubernetes.mjs";

/** Live acceptance only: interrupt one fixture's actual Runner and require kubelet evidence. */
async function interruptOwnedWorker(database, tenantId, runId, signal) {
  const other = await database
    .selectFrom("runs")
    .select("id")
    .where("tenant_id", "!=", tenantId)
    .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
    .limit(1)
    .execute();
  assert.equal(other.length, 0, "Other tenants have unfinished work; refusing fault injection");
  const owner = await database
    .selectFrom("runs as r")
    .innerJoin("workers as w", "w.id", "r.worker_id")
    .select(["w.supervisor_id", "r.lease_id"])
    .where("r.id", "=", runId)
    .where("r.tenant_id", "=", tenantId)
    .where("r.state", "=", "running")
    .executeTakeFirstOrThrow();
  const state = () =>
    JSON.parse(
      kubectl(["get", "pod", owner.supervisor_id, "-o", "json"]),
    ).status.containerStatuses.find((container) => container.name === "pi-worker");
  const before = state();
  const kill = `const fs=require('node:fs');const pids=fs.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p)&&p!=='1').filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split(String.fromCharCode(0)).includes('/app/packages/supervisor-host/src/main.ts')}catch(e){if(e.code==='ENOENT')return false;throw e}});if(pids.length!==1)throw Error('Expected one Agent Runner');process.kill(Number(pids[0]),'${signal}')`;
  const startedAt = performance.now();
  try {
    kubectl(["exec", owner.supervisor_id, "--", "node", "-e", kill], { timeout: 30000 });
  } catch {
    /* A dropped exec channel is not evidence; inspect kubelet below. */
  }
  const deadline = Date.now() + (signal === "SIGTERM" ? 180000 : 90000);
  while (Date.now() < deadline) {
    const current = state(),
      terminated = current.lastState?.terminated;
    if (current.restartCount > before.restartCount && terminated) {
      if (signal === "SIGTERM")
        assert.equal(terminated.exitCode, 0, "Graceful Worker retirement failed");
      else assert(terminated.exitCode > 0);
      return {
        pod: owner.supervisor_id,
        leaseId: owner.lease_id,
        exitCode: terminated.exitCode,
        restartCount: current.restartCount,
        signal,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    }
    await delay(500);
  }
  throw new Error("Kubelet did not confirm the owned Worker interruption");
}

export const crashOwnedWorker = (database, tenantId, runId) =>
  interruptOwnedWorker(database, tenantId, runId, "SIGKILL");
export const retireOwnedWorker = (database, tenantId, runId) =>
  interruptOwnedWorker(database, tenantId, runId, "SIGTERM");
