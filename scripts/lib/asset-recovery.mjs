import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Client } from "pg";
import { parseImageAttachmentReference } from "../../packages/protocol/src/image-attachment.ts";

// Same adopted official image as the owned PostgreSQL integration fixture.
const PG_IMAGE = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const root = fileURLToPath(new URL("../..", import.meta.url));
const terminalStates = "('completed','failed','cancelled','timed_out')";
const identifier = (name) => '"' + name.replaceAll('"', '""') + '"';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function schemaIdentity() {
  const directory = join(root, "packages/database/src/migrations");
  const names = (await readdir(directory)).filter((name) => /^\d+_.+\.ts$/.test(name)).sort();
  const hash = createHash("sha256");
  const packages = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  for (const name of [
    "@earendil-works/pi-durable",
    "@earendil-works/pi-ai",
    "@earendil-works/chord",
  ])
    hash.update(JSON.stringify([name, packages.devDependencies[name]]));
  for (const name of names) hash.update(name).update(await readFile(join(directory, name)));
  return { sha256: hash.digest("hex"), migrations: names.map((name) => name.slice(0, -3)) };
}

async function connect(url) {
  const client = new Client({
    connectionString: url,
    application_name: "pi-cloud-asset-recovery",
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

function postgresTool(name, args, url) {
  const env = { ...process.env };
  const forwarded = [];
  if (url) {
    const endpoint = new URL(url);
    assert(["postgres:", "postgresql:"].includes(endpoint.protocol), "Invalid PostgreSQL URL");
    Object.assign(env, {
      PGHOST: endpoint.hostname,
      PGPORT: endpoint.port || "5432",
      PGUSER: decodeURIComponent(endpoint.username),
      PGPASSWORD: decodeURIComponent(endpoint.password),
      PGDATABASE: decodeURIComponent(endpoint.pathname.slice(1)),
      PGSSLMODE: endpoint.searchParams.get("sslmode") ?? "prefer",
      PGAPPNAME: "pi-cloud-asset-recovery-tool",
      PGCONNECT_TIMEOUT: "5",
    });
    for (const key of [
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGPASSWORD",
      "PGDATABASE",
      "PGSSLMODE",
      "PGAPPNAME",
      "PGCONNECT_TIMEOUT",
    ])
      forwarded.push("--env", key);
  }
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--interactive",
      "--network=host",
      "--read-only",
      "--cap-drop=ALL",
      ...forwarded,
      PG_IMAGE,
      name,
      ...args,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  // SQL diagnostics can contain transcript values/credentials. Never echo them.
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-8192);
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error(`${name} could not start`)));
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${name} failed${diagnostic.match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1] ? " (SQLSTATE " + diagnostic.match(/ERROR:\s+([A-Z0-9]{5})\b/)[1] + ")" : ""}; target remains offline`,
            ),
          ),
    );
  });
  void done.catch(() => {});
  return { child, done };
}

async function fileIdentity(path) {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteLength += chunk.length;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

function objectKey(image) {
  assert(uuid.test(image.tenantId), "Invalid attachment tenant");
  parseImageAttachmentReference({
    id: image.id,
    sha256: image.sha256,
    byteLength: image.byteLength,
    mimeType: image.mimeType,
  });
  return `session-images/${image.tenantId}/${image.id}`;
}
const imagePath = (directory, image) => join(directory, "images", image.tenantId, image.id);

async function assertQuiescent(client) {
  const { rows } = await client.query(`select
    (select count(*) from runs where state not in ${terminalStates} or recovery_requested_at is not null
      or (output_seal_id is not null and output_sealed_at is null))::int as unsettled,
    (select count(*) from session_leases where released_at is null)::int as writers,
    (select count(*) from active_execution_scopes)::int as scopes,
    (select count(*) from pi_durable_records where kind='task' and fields->>'status'<>'terminal')::int as tasks,
    (select count(*) from pi_durable_records where kind='submission' and fields->>'status' in ('queued','placed'))::int as submissions,
    (select count(*) from pi_durable_current where replay_seq is not null)::int as live_recovery`);
  assert(
    Object.values(rows[0]).every((n) => n === 0),
    "Asset backup requires settled Runs, projected seals and closed native writers/tasks",
  );
}

/** Cold operator snapshot. The table locks also exclude the image reaper; this
 * intentionally is not a hot runtime network-inside-transaction code path. */
export async function backupAssets({
  databaseUrl,
  blobs,
  directory,
  revision,
  signal = AbortSignal.timeout(30 * 60_000),
}) {
  assert(/^[a-f0-9]{40}$/.test(revision), "Backup needs a source commit");
  directory = resolve(directory);
  const stage = directory + `.incomplete-${randomUUID()}`;
  assert(!(await stat(directory).catch(() => null)), "Backup destination already exists");
  await mkdir(stage, { mode: 0o700 });
  let client;
  let manifest;
  try {
    client = await connect(databaseUrl);
    await client.query("begin");
    const tables = (
      await client.query(
        "select tablename from pg_tables where schemaname='public' order by tablename",
      )
    ).rows;
    assert(tables.length, "Source database is empty");
    await client.query(
      `lock table ${tables.map((row) => `public.${identifier(row.tablename)}`).join(",")} in share mode nowait`,
    );
    await assertQuiescent(client);
    const schema = await schemaIdentity();
    const applied = (
      await client.query("select name from kysely_migration order by name")
    ).rows.map((row) => row.name);
    assert.deepEqual(applied, schema.migrations, "Source schema does not match this checkout");
    const snapshot = (await client.query("select pg_export_snapshot() as id")).rows[0].id;
    const images = (
      await client.query(`select o.* from session_image_objects o where exists
      (select 1 from session_image_references r where r.tenant_id=o.tenant_id and r.image_id=o.id)
      order by o.tenant_id,o.id`)
    ).rows.map((row) => {
      assert.equal(row.state, "ready", "Referenced image is not ready");
      return {
        tenantId: row.tenant_id,
        id: row.id,
        sha256: row.sha256,
        byteLength: Number(row.byte_length),
        mimeType: row.mime_type,
      };
    });
    const dumpPath = join(stage, "database.dump");
    const dump = postgresTool(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl", `--snapshot=${snapshot}`],
      databaseUrl,
    );
    dump.child.stdin.end();
    try {
      await Promise.all([
        pipeline(dump.child.stdout, createWriteStream(dumpPath, { flags: "wx", mode: 0o600 }), {
          signal,
        }),
        dump.done,
      ]);
    } finally {
      if (dump.child.exitCode === null) dump.child.kill();
    }
    for (const image of images) {
      const path = imagePath(stage, image);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await pipeline(
        blobs.readStream(objectKey(image), image.byteLength, signal),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      assert.deepEqual(
        await fileIdentity(path),
        { sha256: image.sha256, byteLength: image.byteLength },
        "Image copy integrity failed",
      );
    }
    manifest = {
      formatVersion: 1,
      kind: "pi-cloud-cold-assets",
      createdAt: new Date().toISOString(),
      revision,
      schemaSha256: schema.sha256,
      database: await fileIdentity(dumpPath),
      images,
    };
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await client.query("commit");
    // Only the final rename makes a bundle selectable for restore.
    await rename(stage, directory);
    return manifest;
  } finally {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
    await rm(stage, { recursive: true, force: true });
  }
}

export async function verifyAssetBackup(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert(
    manifest.formatVersion === 1 && manifest.kind === "pi-cloud-cold-assets",
    "Unsupported/incomplete asset backup",
  );
  assert.equal(
    manifest.schemaSha256,
    (await schemaIdentity()).sha256,
    "Backup requires its matching database schema checkout",
  );
  assert.deepEqual(
    await fileIdentity(join(directory, "database.dump")),
    manifest.database,
    "Database archive integrity failed",
  );
  assert(Array.isArray(manifest.images), "Invalid image inventory");
  const seen = new Set();
  for (const image of manifest.images) {
    const key = objectKey(image);
    assert(!seen.has(key), "Duplicate attachment identity");
    seen.add(key);
    assert.deepEqual(
      await fileIdentity(imagePath(directory, image)),
      { sha256: image.sha256, byteLength: image.byteLength },
      "Attachment integrity failed",
    );
  }
  return manifest;
}

/** Stream pg_restore SQL and the authority reset through ONE psql transaction.
 * A failed decode/reset/connection cannot leave runnable old state committed. */
export async function restoreAssets({
  databaseUrl,
  blobs,
  assertEmptyBucket,
  directory,
  signal = AbortSignal.timeout(30 * 60_000),
}) {
  const manifest = await verifyAssetBackup(directory);
  const client = await connect(databaseUrl);
  const uploaded = [];
  let committed = false;
  try {
    assert(
      (await client.query("select pg_try_advisory_lock(7327047391981) as acquired")).rows[0]
        .acquired,
      "Another restore owns this target database",
    );
    assert.equal(
      (await client.query("select count(*)::int as n from pg_tables where schemaname='public'"))
        .rows[0].n,
      0,
      "Restore target database must be empty",
    );
    await assertEmptyBucket();
    for (const image of manifest.images) {
      const key = objectKey(image);
      uploaded.push(key);
      await blobs.putStream(
        key,
        createReadStream(imagePath(directory, image)),
        image.byteLength,
        image.mimeType,
        signal,
      );
      const hash = createHash("sha256");
      let length = 0;
      for await (const chunk of blobs.readStream(key, image.byteLength, signal)) {
        hash.update(chunk);
        length += chunk.length;
      }
      assert(
        length === image.byteLength && hash.digest("hex") === image.sha256,
        "Restored attachment integrity failed",
      );
    }
    const restore = postgresTool("pg_restore", [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--file=-",
    ]);
    const psql = postgresTool(
      "psql",
      ["-X", "--quiet", "--set=ON_ERROR_STOP=1", "--set=VERBOSITY=sqlstate", "--file=-"],
      databaseUrl,
    );
    psql.child.stdout.resume();
    const abort = () => {
      restore.child.kill();
      psql.child.kill();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      // Explicit COMMIT is sent only AFTER a complete decode and authority reset.
      // psql --single-transaction would commit on an otherwise clean early EOF.
      psql.child.stdin.write(`begin; do $$ begin
        if exists(select 1 from pg_tables where schemaname='public')
          then raise exception 'Restore target is not empty'; end if;
      end $$;\n`);
      await Promise.all([
        pipeline(createReadStream(join(directory, "database.dump")), restore.child.stdin, {
          signal,
        }),
        pipeline(restore.child.stdout, psql.child.stdin, { end: false, signal }),
        restore.done,
      ]);
      signal.throwIfAborted();
      psql.child.stdin.end(
        (await readFile(new URL("asset-recovery.sql", import.meta.url), "utf8")) + "\ncommit;\n",
      );
      await psql.done;
      committed = true;
    } finally {
      signal.removeEventListener("abort", abort);
      for (const { child } of [restore, psql]) if (child.exitCode === null) child.kill();
      await Promise.allSettled([restore.done, psql.done]);
    }
    return {
      restored: true,
      images: manifest.images.length,
      recoveryPoint: manifest.createdAt,
      revision: manifest.revision,
    };
  } finally {
    await client.end();
    // After an uncertain psql exit the target must remain offline and retain
    // uploaded bytes for inspection. Deleting them could break a committed DB.
    if (!committed && uploaded.length)
      process.stderr.write(
        "Asset restore did not confirm completion; keep target offline and inspect/recreate this owned target before retrying.\n",
      );
  }
}
