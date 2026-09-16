import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  type ExecuteTurnCommandMessage,
} from "@pi-cloud/protocol";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  PI_SETTLEMENT_GATE_CUSTOM_TYPE,
  PiSettlementGateController,
  settlementGatePolicyFromCommand,
} from "../src/index.ts";

function install() {
  return new PiSettlementGateController({
    command: "npm test",
    cwd: ".",
    timeoutMs: 120_000,
    maximumFollowUps: 1,
  });
}

function emit(
  controller: PiSettlementGateController,
  name: string,
  event: Record<string, unknown>,
): void {
  controller.observe({ type: name, ...event } as AgentEvent);
}

describe("Pi settlement gate", () => {
  it("is absent by default and is enabled only by the named project recipe command", () => {
    const base = {
      payload: { environment: { recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE } },
    } as unknown as ExecuteTurnCommandMessage;
    expect(settlementGatePolicyFromCommand(base)).toBeUndefined();

    const configured = {
      payload: {
        environment: {
          recipe: {
            ...DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
            verificationCommands: [
              ...DEFAULT_PROJECT_ENVIRONMENT_RECIPE.verificationCommands,
              {
                id: "settlement-gate",
                command: "npm test",
                cwd: ".",
                timeoutMs: 120_000,
                network: "none",
              },
            ],
          },
        },
      },
    } as unknown as ExecuteTurnCommandMessage;
    expect(settlementGatePolicyFromCommand(configured)).toEqual({
      command: "npm test",
      cwd: ".",
      timeoutMs: 120_000,
      maximumFollowUps: 1,
    });
  });

  it("queues exactly one Pi-native follow-up after a mutating run without verification", () => {
    const controller = install();
    emit(controller, "tool_execution_start", {
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "src/index.ts", content: "export {};" },
    });
    emit(controller, "tool_execution_end", {
      toolCallId: "write-1",
      toolName: "write",
      result: {},
      isError: false,
    });
    emit(controller, "message_end", {
      message: { role: "assistant", stopReason: "error" },
    });
    expect(controller.prepareFollowUp()).toBeUndefined();

    emit(controller, "message_end", {
      message: { role: "assistant", stopReason: "stop" },
    });

    const followUp = controller.prepareFollowUp();
    expect(followUp).toEqual(
      expect.objectContaining({
        customType: PI_SETTLEMENT_GATE_CUSTOM_TYPE,
        display: false,
        details: { schemaVersion: 1 },
      }),
    );
    expect(JSON.stringify(followUp)).toContain("npm test");
    expect(controller.prepareFollowUp()).toBeUndefined();
  });

  it("settles immediately when the configured verification already succeeded", () => {
    const controller = install();
    emit(controller, "tool_execution_start", {
      toolCallId: "bash-1",
      toolName: "bash",
      args: { command: "npm test" },
    });
    emit(controller, "tool_execution_end", {
      toolCallId: "bash-1",
      toolName: "bash",
      result: {},
      isError: false,
    });
    emit(controller, "message_end", {
      message: { role: "assistant", stopReason: "stop" },
    });
    expect(controller.prepareFollowUp()).toBeUndefined();
  });
});
