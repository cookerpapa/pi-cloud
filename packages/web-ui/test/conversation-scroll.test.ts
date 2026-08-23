import { describe, expect, it } from "vitest";
import { isConversationTailVisible } from "../src/conversation-scroll.ts";

describe("conversation tail following", () => {
  it("keeps following while the reader remains near the latest output", () => {
    expect(
      isConversationTailVisible({ scrollTop: 1_010, scrollHeight: 2_000, clientHeight: 900 }),
    ).toBe(true);
  });

  it("stops following when the reader scrolls into history", () => {
    expect(
      isConversationTailVisible({ scrollTop: 400, scrollHeight: 2_000, clientHeight: 900 }),
    ).toBe(false);
  });
});
