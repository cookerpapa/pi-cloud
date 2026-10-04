import type { Readable } from "node:stream";

/** One process-local, operation-scoped control pipe. No PID registry or server. */
export function toolCancellationInput(input: Readable, operationId: string) {
  const controller = new AbortController();
  let pending = "";
  let failure: Error | undefined;
  const fail = () => {
    failure ??= new Error("Invalid native Tool cancellation transport");
    controller.abort(failure);
  };
  const data = (chunk: Buffer | string) => {
    pending += chunk.toString();
    if (Buffer.byteLength(pending) > 1024) {
      fail();
      return;
    }
    let end: number;
    while ((end = pending.indexOf("\n")) !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const value = JSON.parse(frame);
        if (
          value.type !== "worker.cancel" ||
          value.operationId !== operationId ||
          Object.keys(value).length !== 2
        ) {
          fail();
          return;
        }
        controller.abort(new Error("Tool cancelled by Agent"));
      } catch {
        fail();
        return;
      }
    }
  };
  input.on("data", data);
  input.on("error", fail);
  return {
    signal: controller.signal,
    check() {
      if (failure) throw failure;
    },
    close() {
      input.removeListener("data", data);
      input.removeListener("error", fail);
      input.destroy();
    },
  };
}
