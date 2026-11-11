import { Duplex } from "node:stream";
import type { Boxlite } from "@boxlite-ai/boxlite";

export type NativeBox = NonNullable<Awaited<ReturnType<Boxlite["get"]>>>;
export type NativeExecution = Awaited<ReturnType<NativeBox["exec"]>>;
type NativeOutput = Awaited<ReturnType<NativeExecution["stdout"]>>;

/** Drain native output with a caller-owned bound; the fixed Guest bounds Tool
 * results before they reach this bridge. This path is for short control calls. */
export async function collectExecution(
  execution: NativeExecution,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let bytes = 0;
  const abort = Promise.withResolvers<never>();
  const stop = () => {
    void execution.kill().catch(() => {});
    if (signal?.aborted) abort.reject(signal.reason);
  };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", stop, { once: true });
  const read = async (source: NativeOutput) => {
    const chunks: string[] = [];
    for (;;) {
      signal?.throwIfAborted();
      const value = await source.next();
      if (value === null) break;
      bytes += Buffer.byteLength(value);
      if (bytes > maximumBytes) {
        stop();
        throw new Error("Provider control output exceeded its bound");
      }
      chunks.push(value);
    }
    return chunks.join("");
  };
  try {
    const work = Promise.all([
      execution.stdout().then(read),
      execution.stderr().then(read),
      execution.wait(),
    ]);
    const [stdout, stderr, result] = await Promise.race([work, abort.promise]);
    signal?.throwIfAborted();
    return { stdout, stderr, exitCode: result.exitCode };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/** Native BoxLite TCP stream with Node backpressure and independent half-close. */
export function tunnelStream(
  connection: Awaited<ReturnType<Awaited<ReturnType<NativeBox["network"]["tunnel"]>>["connect"]>>,
): Duplex {
  let reading = false;
  return new Duplex({
    allowHalfOpen: true,
    read() {
      if (reading) return;
      reading = true;
      void (async () => {
        try {
          while (!this.destroyed) {
            const chunk = await connection.read(64 * 1024);
            if (!chunk.length) {
              this.push(null);
              break;
            }
            if (!this.push(chunk)) break;
          }
        } catch (error) {
          this.destroy(error as Error);
        } finally {
          reading = false;
        }
      })();
    },
    write(chunk: Buffer, _encoding, done) {
      void (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await connection.write(chunk.subarray(offset));
          if (written < 1) throw new Error("BoxLite tunnel stopped accepting bytes");
          offset += written;
        }
      })().then(() => done(), done);
    },
    final(done) {
      void connection.shutdownWrite().then(() => done(), done);
    },
    destroy(error, done) {
      void connection.close().then(
        () => done(error),
        () => done(error),
      );
    },
  });
}

/** The bridge owns only the interactive stream. Closing it never retires a VM. */
export async function executionStream(
  execution: NativeExecution,
  combineStderr = true,
  cancelOnDisconnect = false,
): Promise<Duplex> {
  const input = await execution.stdin();
  const stderr = await execution.stderr();
  const streams = [await execution.stdout(), ...(combineStderr ? [stderr] : [])];
  let readers = streams.length;
  let completed = false;
  const wakes = new Set<() => void>();
  const output = new Duplex({
    read() {
      for (const wake of wakes) wake();
      wakes.clear();
    },
    write(chunk: Buffer, _encoding, done) {
      void input.write(chunk).then(() => done(), done);
    },
    final(done) {
      void input.close().then(() => done(), done);
    },
    destroy(error, done) {
      for (const wake of wakes) wake();
      wakes.clear();
      void input.close().catch(() => {});
      if (cancelOnDisconnect && !completed) void execution.kill().catch(() => {});
      done(error);
    },
  });
  for (const stream of streams)
    void (async () => {
      try {
        while (!output.destroyed) {
          const chunk = await stream.next();
          if (chunk === null) break;
          if (!output.push(Buffer.from(chunk)))
            await new Promise<void>((resolve) => wakes.add(resolve));
        }
      } catch (error) {
        output.destroy(error as Error);
      } finally {
        if (--readers === 0) output.push(null);
      }
    })();
  if (!combineStderr)
    void (async () => {
      try {
        while (!output.destroyed && (await stderr.next()) !== null) {
          /* separate diagnostic stream */
        }
      } catch (error) {
        output.destroy(error as Error);
      }
    })();
  void execution.wait().then(
    () => {
      completed = true;
    },
    (error: Error) => output.destroy(error),
  );
  return output;
}
