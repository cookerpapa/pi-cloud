import assert from "node:assert/strict";
import WebSocket from "ws";
import { SandboxControlServer } from "../../../sandbox-control/src/sandbox-control-server.ts";
import { SANDBOX_CONTROL_TERMINAL_PATH } from "@pi-cloud/protocol";

const draining = Promise.withResolvers();
const entered = Promise.withResolvers();
const token = "owned-shutdown-" + "s".repeat(40);
const server = new SandboxControlServer({
  host: "127.0.0.1",
  port: 0,
  serviceToken: token,
  terminalToken: token,
  broker: {
    checkHealth: async () => {},
    close: async () => {
      entered.resolve();
      await draining.promise;
    },
    providerId: "owned-test",
    activeCount: 0,
    admittedCount: 0,
    admissionWaitingCount: 0,
    maximumActiveSandboxes: 10,
    cleanPrewarmCount: 0,
  },
});
const address = await server.listen();
const closing = server.close();
await entered.promise;
const url = new URL(SANDBOX_CONTROL_TERMINAL_PATH, address);
url.protocol = "ws:";
const peer = new WebSocket(url);
const refusal = await new Promise((resolve) => peer.once("error", resolve));
assert.match(refusal.message, /503/);
peer.terminate();
draining.resolve();
let timer;
const outcome = await Promise.race([
  closing.then(() => "closed"),
  new Promise((resolve) => {
    timer = setTimeout(() => resolve("stuck"), 1500);
  }),
]);
clearTimeout(timer);
assert.equal(outcome, "closed", "Rejected upgrade retained a socket after shutdown");
console.log("owned_terminal_shutdown_settled");
