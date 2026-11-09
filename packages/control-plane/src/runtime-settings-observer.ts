import { PostgresNotificationWake } from "@pi-cloud/database";

export const RUNTIME_SETTINGS_CHANNEL = "pi_cloud_runtime_settings";

/** Notifications are wakeups only; PG keeps the authoritative configuration. */
export class RuntimeSettingsObserver {
  readonly #abort = new AbortController();
  readonly #wake: PostgresNotificationWake;
  #running: Promise<void> | undefined;
  constructor(
    connectionString: string,
    readonly read: () => Promise<unknown>,
  ) {
    this.#wake = new PostgresNotificationWake(connectionString, RUNTIME_SETTINGS_CHANNEL);
  }
  start(): void {
    this.#running ??= this.#run();
  }
  async #run(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      this.#wake.refresh();
      const generation = this.#wake.generation;
      try {
        await this.read();
      } catch {
        /* bounded reconciliation retries */
      }
      await this.#wake.wait(generation, 60_000, this.#abort.signal);
    }
  }
  async close(): Promise<void> {
    this.#abort.abort();
    await this.#running;
    await this.#wake.close();
  }
}
