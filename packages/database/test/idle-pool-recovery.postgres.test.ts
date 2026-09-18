import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

it.skipIf(!endpoint)(
  "survives idle, checked-out-between-SQL and active connection loss without replay",
  async () => {
    const name = `pi_idle_pool_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: endpoint, max: 1 });
    await admin.query(`create database "${name}"`);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    const script = `
    import { createDatabase } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).href)};
    import { sql } from 'kysely';
    const db = createDatabase({connectionString:process.env.POOL_TEST_URL,maxConnections:1});
    const send = value => process.send(value);
    let releaseHeld;
    const probe = async phase => send({phase,...(await sql\`select pg_backend_pid() as pid, \${1}::int as value\`.execute(db)).rows[0]});
    process.on('message', async command => {
      if(command==='query') await probe('recovered');
      else if(command==='held') {
        try {
          await db.transaction().execute(async tx => {
            const held = new Promise(resolve=>{releaseHeld=resolve});
            const row=(await sql\`select pg_backend_pid() as pid\`.execute(tx)).rows[0];
            send({phase:'held',...row}); await held;
            await sql\`select 1\`.execute(tx);
          });
          send({phase:'unexpected_success'});
        } catch(error) { send({phase:'held_rejected'}); }
      } else if(command==='release-held') releaseHeld();
      else if(command==='active') {
        try { await sql\`select pg_sleep(30)\`.execute(db);send({phase:'unexpected_success'}); }
        catch(error) { send({phase:'query_rejected',code:error.code}); }
      } else if(command==='quit') { await db.destroy();process.disconnect(); }
    });
    await probe('ready');
  `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, POOL_TEST_URL: url.toString() },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const messages: Array<{ phase: string; pid?: number; value?: number; code?: string }> = [];
    let idleReported = false;
    child.on("message", (message) => messages.push(message as (typeof messages)[number]));
    // Do not reproduce pg's credential-bearing Client dump in test output.
    child.stderr!.on("data", (bytes: Buffer) => {
      if (bytes.toString().includes('"event":"database.idle_connection_lost"')) idleReported = true;
    });
    const message = async (phase: string) => {
      await vi.waitFor(
        () => {
          expect(child.exitCode, `child exited before ${phase}`).toBeNull();
          expect(messages.some((m) => m.phase === phase)).toBe(true);
        },
        { timeout: 5_000, interval: 20 },
      );
      return messages.find((m) => m.phase === phase)!;
    };
    const terminate = async (pid: number) => {
      const result = await admin.query(
        "select pg_terminate_backend(pid) as stopped from pg_stat_activity where pid=$1 and datname=$2",
        [pid, name],
      );
      expect(result.rows).toEqual([{ stopped: true }]);
    };
    try {
      const ready = await message("ready");
      await terminate(ready.pid!);
      await vi.waitFor(
        () => {
          expect(child.exitCode, "idle pool loss crashed the child").toBeNull();
          expect(idleReported).toBe(true);
        },
        { timeout: 5_000, interval: 20 },
      );
      child.send("query");
      const recovered = await message("recovered");
      expect(recovered.value).toBe(1);
      expect(recovered.pid).not.toBe(ready.pid);
      child.send("active");
      await vi.waitFor(
        async () => {
          const result = await admin.query(
            "select wait_event from pg_stat_activity where pid=$1 and datname=$2",
            [recovered.pid, name],
          );
          expect(result.rows).toEqual([{ wait_event: "PgSleep" }]);
        },
        { timeout: 5_000, interval: 20 },
      );
      await terminate(recovered.pid!);
      expect((await message("query_rejected")).code).toBe("57P01");
      expect(messages.some((m) => m.phase === "unexpected_success")).toBe(false);
      child.send("held");
      const held = await message("held");
      await terminate(held.pid!);
      await vi.waitFor(async () => {
        expect(
          (
            await admin.query("select count(*)::int n from pg_stat_activity where pid=$1", [
              held.pid,
            ])
          ).rows[0].n,
        ).toBe(0);
        expect(child.exitCode).toBeNull();
      });
      child.send("release-held");
      await message("held_rejected");
      expect(messages.some((m) => m.phase === "unexpected_success")).toBe(false);
      child.send("quit");
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 5_000, interval: 20 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      try {
        await vi.waitFor(
          async () => {
            const result = await admin.query(
              "select count(*)::int as n from pg_stat_activity where datname=$1",
              [name],
            );
            expect(result.rows[0].n).toBe(0);
          },
          { timeout: 5_000, interval: 20 },
        );
        await admin.query(`drop database "${name}"`);
      } finally {
        await admin.end();
      }
    }
  },
  20_000,
);
