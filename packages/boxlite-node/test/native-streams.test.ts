import { expect, it, vi } from "vitest";
import { collectExecution, executionStream, type NativeExecution } from "../src/native-streams.ts";

function fixture(stdout: string[], stderr: string[]) {
  const kill = vi.fn(async () => {}),
    close = vi.fn(async () => {});
  const execution = {
    stdout: async () => ({ next: async () => stdout.shift() ?? null }),
    stderr: async () => ({ next: async () => stderr.shift() ?? null }),
    stdin: async () => ({ write: async () => {}, close }),
    wait: async () => ({ exitCode: 0 }),
    kill,
  } as unknown as NativeExecution;
  return { execution, kill, close };
}
it("bounds combined control output before constructing a reply", async () => {
  const f = fixture(["1234"], ["5678"]);
  await expect(collectExecution(f.execution, 6)).rejects.toThrow("bound");
  expect(f.kill).toHaveBeenCalledOnce();
});
it("does not wait indefinitely for broken SDK streams after the original deadline", async () => {
  const f = fixture([], []),
    cancel = new AbortController();
  f.execution.stdout = async () => ({ next: () => new Promise(() => {}) });
  f.execution.wait = () => new Promise(() => {});
  const waiting = collectExecution(f.execution, 10, cancel.signal);
  cancel.abort(new Error("original deadline"));
  await expect(waiting).rejects.toThrow("original deadline");
  expect(f.kill).toHaveBeenCalledOnce();
});
it("keeps diagnostic stderr out of workflow protocol bytes and preserves completed work", async () => {
  const f = fixture(['{"result":1}\n'], ["diagnostic\n"]);
  const stream = await executionStream(f.execution, false, true);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('{"result":1}\n');
  expect(f.kill).not.toHaveBeenCalled();
});
