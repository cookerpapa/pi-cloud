import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { ToolResultDeliveryBudget } from "../src/tool-transport-capacity.ts";

const servers: Server[] = [],
  sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listening(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  return address.port;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Delivery condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("counts pending duplicate readers, rejects overload, and detaches disconnected waits", async () => {
  const budget = new ToolResultDeliveryBudget({
    maximumResultReaders: 1,
    maximumSendingBytes: 1000,
    sendTimeoutMs: 1000,
  });
  let detached = 0;
  const port = await listening(
    createServer((_request, response) => {
      try {
        const delivery = budget.open(response);
        delivery.signal.addEventListener("abort", () => {
          detached++;
        });
      } catch {
        response.writeHead(503).end("busy");
      }
    }),
  );
  const controller = new AbortController();
  const waiting = fetch(`http://127.0.0.1:${port}`, { signal: controller.signal }).catch(
    () => undefined,
  );
  await until(() => budget.statistics().resultReaders === 1);
  expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(503);
  controller.abort();
  await waiting;
  await until(() => detached === 1);
  expect(budget.statistics()).toEqual({ resultReaders: 0, sendingBytes: 0 });
});

it("bounds bytes for slow sockets and times out sending without pinning the reader budget", async () => {
  const bytes = 8 * 1024 * 1024;
  const budget = new ToolResultDeliveryBudget({
    maximumResultReaders: 4,
    maximumSendingBytes: bytes,
    sendTimeoutMs: 300,
  });
  const port = await listening(
    createServer((_request, response) => {
      const delivery = budget.open(response);
      try {
        delivery.sending(bytes);
        response.writeHead(200, { "content-length": bytes }).end(Buffer.alloc(bytes));
      } catch {
        delivery.close();
        response.writeHead(503).end("busy");
      }
    }),
  );
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  socket.pause();
  socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await until(() => budget.statistics().sendingBytes === bytes);
  expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(503);
  await until(() => budget.statistics().resultReaders === 0);
  expect(budget.statistics().sendingBytes).toBe(0);
});

it("releases a normal response on finish without waiting for keep-alive connection close", async () => {
  const budget = new ToolResultDeliveryBudget({
    maximumResultReaders: 1,
    maximumSendingBytes: 100,
    sendTimeoutMs: 1000,
  });
  const port = await listening(
    createServer((_request, response) => {
      const delivery = budget.open(response);
      delivery.sending(2);
      response.end("ok");
    }),
  );
  expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ok");
  await until(() => budget.statistics().resultReaders === 0);
  expect(budget.statistics().sendingBytes).toBe(0);
});
