import { setTimeout as delay } from "node:timers/promises";
import { PostgresNotificationWake, PostgresQueueWake } from "@pi-cloud/database";
import type { SessionScheduleService } from "./session-schedule-service.ts";

/** Notifications and one deadline timer wake a PG-authoritative admission pass. */
export class SessionScheduleController {
  readonly #abort = new AbortController();
  readonly #wake: PostgresQueueWake;
  readonly #listener: PostgresNotificationWake | undefined;
  #pending: Promise<void> | undefined;
  constructor(
    readonly options: {
      service: Pick<SessionScheduleService, "nextWake" | "dispatchDue">;
      notificationConnectionString?: string;
      wake?: PostgresQueueWake;
      fallbackMs?: number;
      canDispatch?(): boolean;
      guard?<T>(work: () => Promise<T>): Promise<T>;
      onBatch?(value: { examined: number; admitted: number; advanced: number }): void;
      onError?(): void;
    },
  ) {
    if (options.wake) this.#wake = options.wake;
    else {
      if (!options.notificationConnectionString)
        throw Error("Schedule notification connection is required");
      this.#listener = new PostgresNotificationWake(
        options.notificationConnectionString,
        "pi_cloud_schedules",
      );
      this.#wake = this.#listener;
    }
    if (!Number.isSafeInteger(options.fallbackMs ?? 60000) || (options.fallbackMs ?? 60000) < 1)
      throw Error("Invalid schedule fallback interval");
  }
  start(): void {
    this.#pending ??= this.#run();
  }
  async #run(): Promise<void> {
    const signal = this.#abort.signal,
      fallback = this.options.fallbackMs ?? 60000;
    let failures = 0,
      lastScan = -Infinity;
    while (!signal.aborted) {
      // Coalesce sustained change bursts, not only messages inside one scan.
      const debounce = Math.max(0, 25 - (performance.now() - lastScan));
      if (debounce) await delay(debounce, undefined, { signal }).catch(() => {});
      if (signal.aborted) break;
      lastScan = performance.now();
      this.#listener?.refresh();
      const generation = this.#wake.generation;
      try {
        const { now, next } = await this.options.service.nextWake();
        let pause = Math.min(
          fallback,
          next ? Math.max(1, next.valueOf() - now.valueOf()) : fallback,
        );
        if (next && next <= now && (this.options.canDispatch?.() ?? true)) {
          const work = () => this.options.service.dispatchDue();
          const result = this.options.guard ? await this.options.guard(work) : await work();
          if (result.advanced) {
            this.options.onBatch?.(result);
            failures = 0;
            // Yield between bounded admissions; never await Agent work here.
            await delay(5, undefined, { signal });
            continue;
          }
          pause = Math.min(fallback, 500); // Contended/stale rows cannot cause a hot query loop.
        } else if (next && next <= now) pause = Math.min(fallback, 1000);
        failures = 0;
        await this.#wake.wait(generation, pause, signal);
      } catch {
        if (signal.aborted) break;
        this.options.onError?.();
        failures++;
        await delay(Math.min(30000, 250 * 2 ** Math.min(failures, 7)), undefined, { signal }).catch(
          () => {},
        );
      }
    }
  }
  async close(): Promise<void> {
    this.#abort.abort();
    await this.#pending;
    await this.#listener?.close();
  }
}
