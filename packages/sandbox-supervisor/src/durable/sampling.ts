import type { FrozenCloudStep } from "../cloud-context.ts";
import type { PiWorldStateModelMessage } from "../pi-sandbox-continuity.ts";
export type PiSamplingStepCapture = Readonly<{
  step: FrozenCloudStep;
  modelMessages: readonly PiWorldStateModelMessage[];
  samplingAttempt: number;
}>;

/** Request identity comes from Pi's acknowledged checkpoint, never an async UI
 * retry notification or a second persisted Step counter. One restore may bind
 * the same checkpoint to a new cloud execution/world snapshot. */
export class DurableSampling {
  #boundary: { sequence: number; attempt: number; publish: boolean } | undefined;
  #capture: Promise<Omit<PiSamplingStepCapture, "samplingAttempt">> | undefined;
  select(boundary: { sequence: number; attempt: number; publish: boolean }): void {
    if (
      !Number.isSafeInteger(boundary.sequence) ||
      boundary.sequence < 1 ||
      !Number.isSafeInteger(boundary.attempt) ||
      boundary.attempt < 1
    )
      throw new Error("Native sampling checkpoint is invalid");
    if (this.#boundary?.sequence !== boundary.sequence) this.#capture = undefined;
    this.#boundary = boundary;
  }
  get selected(): boolean {
    return this.#boundary !== undefined;
  }
  get publish(): boolean {
    return this.#boundary?.publish === true;
  }
  async capture(
    fresh: (sequence: number) => Promise<Omit<PiSamplingStepCapture, "samplingAttempt">>,
  ): Promise<PiSamplingStepCapture> {
    const boundary = this.#boundary;
    if (!boundary) throw new Error("Sampling has no admitted native checkpoint");
    this.#capture ??= fresh(boundary.sequence);
    return { ...(await this.#capture), samplingAttempt: boundary.attempt };
  }
}
