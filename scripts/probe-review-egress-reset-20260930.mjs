// Observe downstream termination after an upstream HTTP response is truncated.
import { createServer, request } from "node:http";
import { writeFile } from "node:fs/promises";
const { createCubeEgressGateway } =
  await import("../packages/cube-egress-gateway/src/proxy-server.ts");
const upstream = createServer((_req, res) => {
  res.writeHead(200, { "content-length": 10000 });
  res.write("partial");
  setTimeout(() => res.destroy(), 25);
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const gateway = createCubeEgressGateway({
  poller: {
    current: {
      enabled: true,
      revision: 1,
      upstreamProxyUrl: new URL("http://127.0.0.1:" + upstream.address().port),
    },
  },
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
let end = false;
const req = request(
  { host: "127.0.0.1", port: gateway.address().port, path: "http://93.184.216.34/test" },
  (res) => {
    res.on("data", () => {});
    res.on("error", () => {
      end = true;
    });
    res.on("end", () => {
      end = true;
    });
  },
);
req.on("error", () => {
  end = true;
});
req.end();
await new Promise((resolve) => setTimeout(resolve, 11000));
const report = {
  method: "localhost proxy stub; no external request",
  waitedMs: 11000,
  upstreamResetAfterMs: 25,
  alive: true,
  responseSettled: end,
};
gateway.closeAllConnections();
upstream.closeAllConnections();
gateway.close();
upstream.close();
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-review-egress-reset.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
