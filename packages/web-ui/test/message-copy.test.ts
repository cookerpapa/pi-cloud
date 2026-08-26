import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMessageText } from "../src/MessageCopyButton.tsx";

afterEach(() => vi.unstubAllGlobals());

describe("message copy", () => {
  it("writes the exact message text through the Clipboard API", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyMessageText("保留 Markdown **源码**\n和换行");

    expect(writeText).toHaveBeenCalledWith("保留 Markdown **源码**\n和换行");
  });
});
