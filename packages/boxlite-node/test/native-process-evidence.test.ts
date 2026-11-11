import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { captureNativeProcesses, confirmsNativeAbsence } from "../src/native-process-evidence.ts";

it("requires the recorded owned process to exit, rather than trusting missing inventory", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    const evidence = await captureNativeProcesses(child.pid!);
    expect(await confirmsNativeAbsence(evidence)).toBe(false);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(await confirmsNativeAbsence(evidence)).toBe(true);
    await expect(confirmsNativeAbsence({ ...evidence, processes: [] })).rejects.toThrow(
      "unavailable",
    );
  } finally {
    child.kill("SIGKILL");
  }
});
