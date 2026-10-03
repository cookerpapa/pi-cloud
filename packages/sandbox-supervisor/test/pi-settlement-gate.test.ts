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
    workingDirectory: "/workspace",
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
  it.each(["/workspace/repository", "/home/user/project", "/home/user/My Project"])(
    "uses the frozen Run directory %s for recognition and reminders",
    (workingDirectory) => {
      const policy = {
        command: "npm test",
        cwd: "frontend",
        workingDirectory,
        timeoutMs: 10000,
        maximumFollowUps: 1 as const,
      };
      const unchecked = new PiSettlementGateController(policy);
      emit(unchecked, "tool_execution_start", { toolCallId: "write", toolName: "write", args: {} });
      emit(unchecked, "tool_execution_end", {
        toolCallId: "write",
        toolName: "write",
        isError: false,
      });
      emit(unchecked, "message_end", { message: { role: "assistant", stopReason: "stop" } });
      expect(JSON.stringify(unchecked.prepareFollowUp())).toContain(`${workingDirectory}/frontend`);
      const checked = new PiSettlementGateController(policy);
      emit(checked, "tool_execution_start", {
        toolCallId: "check",
        toolName: "bash",
        args: { command: `cd '${workingDirectory}/frontend' && npm test` },
      });
      emit(checked, "tool_execution_end", {
        toolCallId: "check",
        toolName: "bash",
        isError: false,
      });
      emit(checked, "message_end", { message: { role: "assistant", stopReason: "stop" } });
      expect(checked.prepareFollowUp()).toBeUndefined();
    },
  );
  it("is absent by default and is enabled only by the named project recipe command", () => {
    const base = {
      payload: { environment: { recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE } },
    } as unknown as ExecuteTurnCommandMessage;
    expect(settlementGatePolicyFromCommand(base)).toBeUndefined();

    const configured = {
      payload: {
        workingDirectory: "/workspace",
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
      workingDirectory: "/workspace",
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

  function start(
    controller: PiSettlementGateController,
    id: string,
    name: string,
    command?: string,
  ) {
    emit(controller, "tool_execution_start", { toolCallId: id, toolName: name, args: { command } });
  }
  function end(controller: PiSettlementGateController, id: string, name: string) {
    emit(controller, "tool_execution_end", {
      toolCallId: id,
      toolName: name,
      isError: false,
      result: {},
    });
  }
  function stop(controller: PiSettlementGateController) {
    emit(controller, "message_end", { message: { role: "assistant", stopReason: "stop" } });
  }

  it.each(["write", "edit", "bash"])(
    "requires verification after a later %s, even with a reused call ID",
    (name) => {
      const controller = install();
      start(controller, "reused", "bash", "npm test");
      end(controller, "reused", "bash");
      start(controller, "reused", name, "touch app.ts");
      end(controller, "reused", name);
      stop(controller);
      expect(controller.prepareFollowUp()).toBeDefined();
      expect(controller.prepareFollowUp()).toBeUndefined();
    },
  );

  it.each(["edit-first", "verify-first"])("does not certify an overlapping edit (%s)", (order) => {
    const controller = install();
    start(controller, "edit", "edit");
    start(controller, "verify", "bash", "npm test");
    if (order === "edit-first") end(controller, "edit", "edit");
    end(controller, "verify", "bash");
    if (order === "verify-first") end(controller, "edit", "edit");
    stop(controller);
    expect(controller.prepareFollowUp()).toBeDefined();
  });

  it("accepts fresh verification after the latest mutation has completed", () => {
    const controller = install();
    start(controller, "same", "edit");
    end(controller, "same", "edit");
    start(controller, "same", "bash", "npm test");
    end(controller, "same", "bash");
    stop(controller);
    expect(controller.prepareFollowUp()).toBeUndefined();
  });
});
