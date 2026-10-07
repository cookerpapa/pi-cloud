import { connect, createServer } from "node:net";

export async function startRegistryForward({ host, port }) {
  const sockets = new Set();
  const server = createServer((downstream) => {
    sockets.add(downstream);
    const upstream = connect({
      host,
      port: Number(port),
    });
    sockets.add(upstream);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    const closePair = () => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.once("error", closePair);
    upstream.once("error", closePair);
    downstream.once("close", () => {
      sockets.delete(downstream);
      sockets.delete(upstream);
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(5_000, "127.0.0.1", resolvePromise);
  });
  return {
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}
