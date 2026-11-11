import type { Duplex } from "node:stream";
import type { SandboxTerminalSession } from "./sandbox-provider.ts";
import type { RuntimeRetention, RuntimeRetentionTarget } from "./runtime-retention.ts";

/** A connection declares use; neither wrapper performs native lifecycle work. */
export function retainTerminal(
  terminal: SandboxTerminalSession,
  retention: RuntimeRetention,
  target: RuntimeRetentionTarget,
): SandboxTerminalSession {
  const release = retention.hold(target);
  return {
    output: (async function* () {
      try {
        yield* terminal.output;
      } finally {
        release();
      }
    })(),
    sendInput: (bytes) => terminal.sendInput(bytes),
    resize: (size) => terminal.resize(size),
    kill: async () => {
      try {
        await terminal.kill();
      } finally {
        release();
      }
    },
    disconnect: () => {
      release();
      terminal.disconnect();
    },
  };
}
export function retainPreview(
  stream: Duplex,
  retention: RuntimeRetention,
  target: RuntimeRetentionTarget,
): Duplex {
  try {
    const release = retention.hold(target);
    stream.once("close", release);
    stream.once("error", release);
    return stream;
  } catch (error) {
    stream.destroy();
    throw error;
  }
}
