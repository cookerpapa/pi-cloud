import { Agent, fetch } from "undici";
import type { ToolResultData } from "@pi-cloud/protocol";

/** A confirmed, ordinary UI error, safe to return to Pi as a Tool error. */
export class AndroidToolError extends Error {}
const uiErrors: Record<string, string> = {
  "no such element":
    "No focused editable element was found. Observe the screen and select an input first.",
  "invalid element state":
    "The selected element cannot accept this input. Observe the screen before trying again.",
  "invalid argument": "Android rejected these input arguments.",
};

/** Pinned WebDriver adapter. Only this code-owned adapter can use the fixed
 * boot-id read; model arguments never become shell commands. */
export class AppiumAndroidDriver {
  readonly #http = new Agent();
  #session: string | undefined;
  #deviceBoot: string | undefined;
  #healthy = false;
  constructor(readonly options: { url: string; udid: string; systemPort: number }) {}
  async #request(
    path: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.options.url), {
      method,
      dispatcher: this.#http,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
        : AbortSignal.timeout(30000),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    if (response.body)
      for await (const part of response.body) {
        size += part.length;
        if (size > 64 * 1024 * 1024) throw new Error("Device response exceeds image boundary");
        chunks.push(Buffer.from(part));
      }
    let envelope;
    try {
      envelope = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new Error("Invalid device response");
    }
    if (!response.ok || envelope.value?.error) {
      const message = uiErrors[envelope.value?.error];
      if (message) throw new AndroidToolError(message);
      throw new Error("Device operation unavailable");
    }
    return envelope.value;
  }
  async open(): Promise<void> {
    const value = (await this.#request(
      "/session",
      "POST",
      {
        capabilities: {
          alwaysMatch: {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:udid": this.options.udid,
            "appium:systemPort": this.options.systemPort,
            "appium:noReset": true,
            "appium:dontStopAppOnReset": true,
            "appium:newCommandTimeout": 0,
            "appium:skipUnlock": true,
            "appium:disableWindowAnimation": true,
            "appium:uiautomator2ServerReadTimeout": 25000,
          },
          firstMatch: [{}],
        },
      },
      AbortSignal.timeout(180000),
    )) as { sessionId?: string };
    if (!value.sessionId) throw new Error("Device session is missing");
    this.#session = value.sessionId;
    this.#deviceBoot = await this.#readBoot();
    this.#healthy = true;
  }
  get ready() {
    return Boolean(this.#session && this.#healthy);
  }
  #call(path: string, method = "GET", body?: unknown, signal?: AbortSignal) {
    if (!this.#session) throw new Error("Device is not ready");
    signal?.throwIfAborted();
    return this.#request(
      "/session/" + encodeURIComponent(this.#session) + path,
      method,
      body,
      signal,
    );
  }
  async #readBoot(signal?: AbortSignal): Promise<string> {
    const boot = await this.#call(
      "/execute/sync",
      "POST",
      {
        script: "mobile: shell",
        args: [{ command: "cat", args: ["/proc/sys/kernel/random/boot_id"], timeout: 5000 }],
      },
      signal,
    );
    if (typeof boot !== "string" || !/^[0-9a-f-]{36}$/.test(boot.trim()))
      throw new Error("Missing device boot identity");
    return boot.trim();
  }
  async #checkBoot(signal?: AbortSignal) {
    if (!this.ready) throw new Error("Device requires a fresh executor");
    try {
      if ((await this.#readBoot(signal)) !== this.#deviceBoot)
        throw new Error("Device was replaced");
    } catch (error) {
      this.#healthy = false;
      throw error;
    }
  }
  async screenshot(signal?: AbortSignal): Promise<string> {
    await this.#checkBoot(signal);
    const value = await this.#call("/screenshot", "GET", undefined, signal);
    if (typeof value !== "string" || !value.length || value.length > 64 * 1024 * 1024)
      throw new Error("Invalid device screenshot");
    if (
      !Buffer.from(value.slice(0, 16), "base64")
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error("Screenshot is not PNG");
    return value;
  }
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResultData> {
    await this.#checkBoot(signal);
    try {
      return await this.#execute(name, args, signal);
    } catch (error) {
      // A transport timeout may have left a UI action in flight. Do not run a
      // second action on this executor until its process/session is replaced.
      if (!(error instanceof AndroidToolError)) this.#healthy = false;
      throw error;
    }
  }
  async #execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResultData> {
    if (name === "android_observe") {
      const data = await this.screenshot(signal);
      // Missing accessibility metadata must not discard a valid screenshot.
      const optional = (path: string) =>
        this.#call(path, "GET", undefined, signal).catch(() => null);
      const hierarchy = await optional("/source"),
        viewport = await optional("/window/rect"),
        app = await optional("/appium/device/current_package");
      signal.throwIfAborted();
      let text = typeof hierarchy === "string" ? hierarchy : "";
      const originalLength = text.length;
      while (Buffer.byteLength(JSON.stringify({ app, viewport, hierarchy: text })) > 48 * 1024)
        text = text.slice(0, Math.floor(text.length * 0.8));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              app,
              viewport,
              hierarchy: text,
              hierarchyTruncated: text.length < originalLength,
            }),
          },
          { type: "image", mimeType: "image/png", data },
        ],
        details: { androidObservation: true },
      };
    }
    if (name === "android_tap")
      await this.#call(
        "/actions",
        "POST",
        {
          actions: [
            {
              type: "pointer",
              id: "finger",
              parameters: { pointerType: "touch" },
              actions: [
                { type: "pointerMove", duration: 0, x: args.x, y: args.y },
                { type: "pointerDown", button: 0 },
                { type: "pause", duration: 80 },
                { type: "pointerUp", button: 0 },
              ],
            },
          ],
        },
        signal,
      );
    else if (name === "android_swipe")
      await this.#call(
        "/actions",
        "POST",
        {
          actions: [
            {
              type: "pointer",
              id: "finger",
              parameters: { pointerType: "touch" },
              actions: [
                { type: "pointerMove", duration: 0, x: args.fromX, y: args.fromY },
                { type: "pointerDown", button: 0 },
                { type: "pointerMove", duration: args.durationMs ?? 500, x: args.toX, y: args.toY },
                { type: "pointerUp", button: 0 },
              ],
            },
          ],
        },
        signal,
      );
    else if (name === "android_input_text") {
      const element = (await this.#call("/element/active", "GET", undefined, signal)) as Record<
        string,
        string
      >;
      const id = element["element-6066-11e4-a52e-4f735466cecf"] ?? element.ELEMENT;
      if (!id) throw new AndroidToolError(uiErrors["no such element"]!);
      await this.#call(
        "/element/" + encodeURIComponent(id) + "/value",
        "POST",
        { text: args.text, value: [args.text] },
        signal,
      );
    } else if (name === "android_key")
      await this.#call(
        "/appium/device/press_keycode",
        "POST",
        { keycode: { back: 4, home: 3, enter: 66, recent: 187 }[args.key as "back"] },
        signal,
      );
    else if (name === "android_open_app")
      await this.#call("/appium/device/activate_app", "POST", { appId: args.packageName }, signal);
    else throw new AndroidToolError("Unknown Android operation");
    return {
      content: [
        {
          type: "text",
          text: "Android input delivered. Use android_observe to verify the resulting screen.",
        },
      ],
    };
  }
  async close(): Promise<void> {
    const session = this.#session;
    this.#healthy = false;
    this.#session = undefined;
    if (session)
      await this.#request(
        "/session/" + encodeURIComponent(session),
        "DELETE",
        undefined,
        AbortSignal.timeout(5000),
      ).catch(() => {});
    await this.#http.close();
  }
}
