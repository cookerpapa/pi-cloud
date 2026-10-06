// A real, disposable PG connection loss. Only a temporary review file is changed.
import assert from "node:assert/strict";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { PostgresWorkspaceVolumeGatewayLock } from "../../../packages/sandbox-control/src/postgres-workspace-volume-gateway-lock.ts";

const fixture = await testPostgres();
const root = await mkdtemp(join(tmpdir(), "pi-review-volume-lock-"));
const pools = Array.from({ length: 3 }, () => new Pool({ connectionString: fixture.url, max: 1 }));
const [oldPool, newPool, observer] = pools;
const events = [];
let oldClient, releaseOld;
const resume = new Promise((resolve) => {
  releaseOld = resolve;
});
let entered;
const ready = new Promise((resolve) => {
  entered = resolve;
});
oldPool.on("connect", (client) => {
  oldClient = client;
});
const file = join(root, "state.json"),
  id = randomUUID();
let oldWork;
try {
  await writeFile(file, JSON.stringify(["initial"]));
  oldWork = new PostgresWorkspaceVolumeGatewayLock(oldPool)
    .withLock(id, async () => {
      const previous = JSON.parse(await readFile(file, "utf8"));
      events.push("old-entered");
      entered();
      await resume;
      await writeFile(file, JSON.stringify([...previous, "old-write"]));
      events.push("old-wrote-after-lock-loss");
    })
    .then(
      () => "resolved",
      () => "rejected",
    );
  await ready;
  const pid = (await oldClient.query("select pg_backend_pid() pid")).rows[0].pid;
  const lost = new Promise((resolve) => oldClient.once("error", resolve));
  await observer.query("select pg_terminate_backend($1)", [pid]);
  await lost;
  await new PostgresWorkspaceVolumeGatewayLock(newPool).withLock(id, async () => {
    events.push("new-entered");
    const previous = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify([...previous, "new-write"]));
    events.push("new-committed");
  });
  releaseOld();
  const oldResult = await oldWork;
  const contents = JSON.parse(await readFile(file, "utf8"));
  assert.equal(oldResult, "rejected");
  console.log(
    JSON.stringify({
      id: "volume-lock-loss",
      events,
      oldResult,
      newWriteRetained: contents.includes("new-write"),
    }),
  );
} finally {
  releaseOld();
  await oldWork;
  await Promise.allSettled(pools.map((pool) => pool.end()));
  await rm(root, { force: true, recursive: true });
  await fixture.close();
}
