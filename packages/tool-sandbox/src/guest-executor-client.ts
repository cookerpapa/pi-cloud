import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { GUEST_EXECUTOR_MAX_INPUT } from "@pi-cloud/protocol/guest";
import { GUEST_STATE, GUEST_SOCKET, guestRpc } from "./guest-executor-ipc.ts";
async function main() {
  if (process.getuid?.() !== 0) throw new Error("root required");
  process.stdout.write("PI_CLOUD_GUEST_READY\n");
  let input = "";
  const decoder = new StringDecoder("utf8");
  for await (const bytes of process.stdin) {
    input += decoder.write(bytes);
    if (Buffer.byteLength(input) > GUEST_EXECUTOR_MAX_INPUT) throw new Error("input limit");
    if (input.includes("\n")) break;
  }
  const request = JSON.parse(input.trim());
  try {
    await guestRpc(GUEST_SOCKET, { version: 1, action: "info" }, 500);
  } catch {
    await mkdir(GUEST_STATE, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ["/opt/pi-cloud/bin/guest-executor-service.mjs"], {
      cwd: "/",
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
    const until = Date.now() + 4000;
    let ready = false;
    while (Date.now() < until) {
      try {
        await guestRpc(GUEST_SOCKET, { version: 1, action: "info" }, 250);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!ready) throw new Error("service unavailable");
  }
  process.stdout.write(JSON.stringify(await guestRpc(GUEST_SOCKET, request)) + "\n");
}
void main()
  .catch(() => {
    process.stdout.write('{"accepted":false,"rejection":"handoff_unconfirmed"}\n');
    process.exitCode = 1;
  })
  .finally(() => process.stdin.destroy());
