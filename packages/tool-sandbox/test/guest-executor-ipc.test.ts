import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { expect, it } from "vitest";
import { guestRpc, listenGuestRpc } from "../src/guest-executor-ipc.ts";
it("preserves UTF-8 tool arguments split across socket chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gx-utf8-")),
    path = join(directory, "rpc");
  const received = Promise.withResolvers<unknown>();
  const server = await listenGuestRpc(path, async (r) => {
    received.resolve(r);
    return { accepted: true };
  });
  const client = createConnection(path);
  client.on("error", () => {});
  client.resume();
  try {
    await new Promise<void>((r) => client.once("connect", r));
    const body = { command: "printf '醍醐'" },
      bytes = Buffer.from(JSON.stringify(body) + "\n"),
      split = bytes.indexOf(Buffer.from("醍")) + 1;
    client.write(bytes.subarray(0, split));
    await new Promise((r) => setTimeout(r, 20));
    client.write(bytes.subarray(split));
    expect(await received.promise).toEqual(body);
  } finally {
    client.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
it("a lost caller connection does not cancel an already accepted Guest request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gx-")),
    socket = join(directory, "rpc");
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  let executions = 0;
  const server = await listenGuestRpc(socket, async () => {
    started.resolve();
    await finish.promise;
    executions++;
    return { accepted: true };
  });
  try {
    const client = createConnection(socket);
    client.on("error", () => {});
    await new Promise<void>((r) =>
      client.once("connect", () => {
        client.write('{"version":1}\n');
        r();
      }),
    );
    await started.promise;
    client.destroy();
    finish.resolve();
    await new Promise((r) => setTimeout(r, 25));
    expect(executions).toBe(1);
    expect(await guestRpc(socket, { version: 1 })).toEqual({ accepted: true });
    expect(executions).toBe(2);
  } finally {
    finish.resolve();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
