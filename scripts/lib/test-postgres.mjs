import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

const execute = promisify(execFile);
const IMAGE = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";

/** Existing integration URLs are caller-owned test infrastructure. Otherwise
 * use a disposable official PG container, with no host mounts or production data. */
export async function testPostgres(environment = process.env) {
  if (environment.PI_CLOUD_POSTGRES_INTEGRATION_URL)
    return { url: environment.PI_CLOUD_POSTGRES_INTEGRATION_URL, async close() {} };
  const name = `pi-cloud-test-pg-${randomUUID()}`;
  let started = false,
    closed = false;
  const close = async () => {
    if (!started || closed) return;
    await execute("docker", ["stop", "--timeout=10", name], { timeout: 30000 }).catch((error) => {
      if (!/No such container/i.test(error.stderr ?? "")) throw error;
    });
    closed = true;
  };
  try {
    await execute(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--memory=768m",
        "--cpus=2",
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        IMAGE,
      ],
      { timeout: 300000 },
    );
    started = true;
    const { stdout } = await execute("docker", ["port", name, "5432/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
    if (!port) throw new Error("Test PostgreSQL has no loopback port");
    const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
    pool.on("error", () => {});
    try {
      const deadline = performance.now() + 30000;
      for (;;) {
        try {
          await pool.query("select 1");
          break;
        } catch {
          if (performance.now() >= deadline)
            throw new Error("Test PostgreSQL did not become ready");
        }
        await delay(100);
      }
    } finally {
      await pool.end();
    }
    return { url, close };
  } catch (error) {
    await close();
    throw new Error(
      "PostgreSQL integration fixture failed; start Docker or supply an isolated PI_CLOUD_POSTGRES_INTEGRATION_URL",
      { cause: error },
    );
  }
}
