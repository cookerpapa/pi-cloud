import type { Message } from "@earendil-works/pi-ai";
import { worldStateMessage } from "./pi-sandbox-continuity.ts";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { modelSamplingHeaders } from "@pi-cloud/protocol";
import type { FrozenCloudStep } from "./cloud-context.ts";
import type { PiWorldStateModelMessage } from "./pi-sandbox-continuity.ts";

export type SamplingContextOptions = Readonly<{
  turnContextSha256: string;
  executionContextSha256: string;
  activeFileTools: readonly string[];
  traceparent?: string;
  tracestate?: string;
  capture(
    activeFileTools: readonly string[],
    purpose: "agent" | "context_maintenance",
  ):
    | {
        step: FrozenCloudStep;
        modelMessages: readonly PiWorldStateModelMessage[];
        samplingAttempt: number;
      }
    | Promise<{
        step: FrozenCloudStep;
        modelMessages: readonly PiWorldStateModelMessage[];
        samplingAttempt: number;
      }>;
}>;

/** Sampling/World State boundary, independent of guest activation and Tool IO. */
export class SamplingContext {
  step: FrozenCloudStep | undefined;
  constructor(readonly options: SamplingContextOptions) {}

  async #capture(purpose: "agent" | "context_maintenance") {
    const captured = await this.options.capture(this.options.activeFileTools, purpose);
    if (
      captured.step.context.turnContextSha256 !== this.options.turnContextSha256 ||
      captured.step.context.executionContextSha256 !== this.options.executionContextSha256 ||
      !/^[0-9a-f]{64}$/.test(captured.step.sha256)
    )
      throw new Error("Captured Cloud Step did not match the accepted Turn and execution contexts");
    if (purpose === "agent") this.step = captured.step;
    return captured;
  }

  async ensureToolContext(): Promise<void> {
    if (!this.step) await this.#capture("agent");
  }

  prepareModelRequest = async (
    input: readonly Message[],
    purpose: "agent" | "context_maintenance" = "agent",
    headers: ProviderHeaders = {},
  ): Promise<{ messages: Message[]; headers: ProviderHeaders }> => {
    const captured = await this.#capture(purpose);
    const messages = [...input];
    for (const message of captured.modelMessages) {
      const key = `pi-cloud-change:${message.details.changeSha256}`;
      const present = messages.some(
        (candidate) =>
          candidate.role === "system" && candidate.sections && key in candidate.sections,
      );
      if (!present) messages.push(worldStateMessage(message));
    }
    return {
      messages,
      headers: {
        ...headers,
        ...(this.options.traceparent === undefined
          ? {}
          : { traceparent: this.options.traceparent }),
        ...(this.options.tracestate === undefined ? {} : { tracestate: this.options.tracestate }),
        ...modelSamplingHeaders({
          stepSequence: captured.step.context.sequence,
          stepSha256: captured.step.sha256,
          samplingAttempt: captured.samplingAttempt,
        }),
      },
    };
  };
}
