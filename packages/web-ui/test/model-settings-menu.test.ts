import { describe, expect, it } from "vitest";
import { defaultModelSettings, settingsFromSessionModel } from "../src/ModelSettingsMenu.tsx";

describe("model settings menu", () => {
  it("uses catalog defaults and keeps Fast scoped to GPT", () => {
    expect(
      defaultModelSettings({
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        default: false,
        thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
        defaultThinkingLevel: "low",
        fastModeAvailable: true,
      }),
    ).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "low",
      fastMode: false,
    });
    expect(
      settingsFromSessionModel({
        sessionId: "10000000-0000-4000-8000-000000000001",
        modelProfileId: "20000000-0000-4000-8000-000000000001",
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        thinkingLevel: "high",
        fastMode: false,
      }),
    ).toMatchObject({ provider: "deepseek", thinkingLevel: "high", fastMode: false });
  });
});
