import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-hardening-"));
  try {
    await mkdir(join(root, "scripts"));
    await cp(
      fileURLToPath(new URL("../prepare-json-parser.mjs", import.meta.url)),
      join(root, "scripts/prepare-json-parser.mjs"),
    );
    const pkg = async (path, version, scope = "") => {
      await mkdir(join(root, scope, "node_modules", path), { recursive: true });
      await writeFile(
        join(root, scope, "node_modules", path, "package.json"),
        JSON.stringify({ version }),
      );
    };
    const invoke = (...args) =>
      spawnSync(process.execPath, [join(root, "scripts/prepare-json-parser.mjs"), ...args], {
        encoding: "utf8",
      });
    await run({ root, pkg, invoke });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("prepares the pinned chunked JSON parser and rejects unknown versions", async () => {
  await fixture(async ({ root, pkg, invoke }) => {
    await pkg("@discoveryjs/json-ext", "1.1.0");
    for (const file of ["src/parse-chunked.js", "cjs/parse-chunked.cjs"]) {
      const path = join(root, "node_modules/@discoveryjs/json-ext", file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "Object.assign(currentRootValueCursor.value, JSON.parse(fragment));");
    }
    expect(invoke("--check").status).not.toBe(0);
    expect(invoke().status).toBe(0);
    expect(invoke("--check").status).toBe(0);
    await pkg("@discoveryjs/json-ext", "9.0.0");
    expect(invoke().status).not.toBe(0);
  });
});

it.each(["../../package.json"])(
  "rejects an unsolicited WebSocket subprotocol without crashing the process at %s",
  (path) => {
    const owner = fileURLToPath(new URL(path, import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const { WebSocket } = require('node:module').createRequire(${JSON.stringify(owner)})('undici');
      const server = require('node:http').createServer();
      let connection;
      server.on('upgrade', (request, socket) => {
        connection = socket;
        const accept = require('node:crypto').createHash('sha1')
          .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n'
          + 'Sec-WebSocket-Accept: ' + accept + '\\r\\nSec-WebSocket-Protocol: unsolicited\\r\\n\\r\\n');
      });
      server.listen(0, '127.0.0.1', () => {
        const ws = new WebSocket('ws://127.0.0.1:' + server.address().port);
        let failed = false;
        ws.addEventListener('error', () => {
          failed = true;
          connection?.destroy();
          server.close();
        });
        ws.addEventListener('open', () => process.exit(3));
        ws.addEventListener('close', () => {
          if (!failed) process.exitCode = 1;
          if (!failed) { connection?.destroy(); server.close(); }
        });
      });
      setTimeout(() => process.exit(2), 3000).unref();
    `,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);

it("does not disclose thrown gRPC handler details through the installed telemetry dependency", () => {
  const owner = fileURLToPath(
    new URL("../../packages/observability/package.json", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const grpc = require('node:module').createRequire(${JSON.stringify(owner)})('@grpc/grpc-js');
    const method = { path: '/private.Probe/Read', requestStream: false, responseStream: false,
      requestSerialize: Buffer.from, requestDeserialize: Buffer.from,
      responseSerialize: Buffer.from, responseDeserialize: Buffer.from };
    const server = new grpc.Server();
    server.addService({ read: method }, { read() { throw new Error('private-grpc-canary'); } });
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (bindError, port) => {
      if (bindError) throw bindError;
      const Client = grpc.makeGenericClientConstructor({ read: method }, 'Probe');
      const client = new Client('127.0.0.1:' + port, grpc.credentials.createInsecure());
      client.read(Buffer.from('probe'), { deadline: new Date(Date.now() + 3000) }, (error) => {
        client.close(); server.forceShutdown();
        const leaked = !!error?.details?.includes('private-grpc-canary');
        if (!error || error.code !== grpc.status.UNKNOWN || leaked) process.exitCode = 1;
      });
    });
    setTimeout(() => process.exit(2), 5000).unref();
  `,
    ],
    { encoding: "utf8", timeout: 7000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
