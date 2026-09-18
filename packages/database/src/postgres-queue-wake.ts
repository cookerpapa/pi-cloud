import { Client } from "pg";

/** A generation remembers hints delivered while the caller is scanning. */
export class PostgresQueueWake {
  #generation = 0;
  #wake: (() => void) | undefined;

  get generation(): number {
    return this.#generation;
  }
  notify(): void {
    this.#generation++;
    this.#wake?.();
  }

  wait(observedGeneration: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#generation !== observedGeneration) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(settle, timeoutMs);
      timer.unref();
      const onAbort = (): void => settle();
      this.#wake = settle;
      if (this.#generation !== observedGeneration) settle();
      function settle(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }).finally(() => {
      this.#wake = undefined;
    });
  }
}

/** Optional acceleration of an authoritative polling loop, never its data source. */
export class PostgresNotificationWake extends PostgresQueueWake {
  readonly #connectionString: string;
  readonly #channel: string;
  #client: Client | undefined;
  #opening: Promise<void> | undefined;
  #closed = false;
  #retryAt = 0;

  constructor(connectionString: string, channel: string) {
    super();
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) throw new Error("Invalid notification channel");
    this.#connectionString = connectionString;
    this.#channel = channel;
  }

  refresh(): void {
    if (this.#closed || this.#client || this.#opening || performance.now() < this.#retryAt) return;
    this.#opening = this.#connect().finally(() => {
      this.#opening = undefined;
    });
  }

  async #connect(): Promise<void> {
    const client = new Client({
      connectionString: this.#connectionString,
      application_name: this.#channel,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
      keepAlive: true,
    });
    this.#client = client;
    const disconnected = (): void => {
      if (this.#client !== client) return;
      this.#client = undefined;
      this.#retryAt = performance.now() + 1_000;
      this.notify();
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "pi-cloud-database",
          event: "database.notification_connection_lost",
          channel: this.#channel,
        }),
      );
      void client.end().catch(() => undefined);
    };
    client.on("error", disconnected);
    client.once("end", disconnected);
    client.on("notification", (message) => {
      if (!this.#closed && this.#client === client && message.channel === this.#channel)
        this.notify();
    });
    try {
      await client.connect();
      if (this.#closed || this.#client !== client) return;
      await client.query(`listen "${this.#channel}"`);
      // LISTEN takes effect before this wake. Scan again for anything committed
      // before registration, even if the first startup scan was already empty.
      if (!this.#closed && this.#client === client) this.notify();
    } catch {
      disconnected();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#client;
    this.#client = undefined;
    try {
      await client?.end();
    } finally {
      await this.#opening;
    }
  }
}
