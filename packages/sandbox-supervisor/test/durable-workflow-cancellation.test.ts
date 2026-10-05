import { expect, it, vi } from "vitest";
import { DurableRemoteTools } from "../src/durable/remote-tools.ts";
import type { CandidateToolCommand, DurableSessionCommit } from "@pi-cloud/protocol";

it.each([false, true])(
  "co-commits an unfinished Workflow cancellation, preserving completed effects (completed=%s)",
  (completed) => {
    const bridge = new DurableRemoteTools({
      definitions: [],
      prepare: async () => {
        throw new Error("not a fixed Tool");
      },
    });
    const command = {
      executionReference: "owner",
      toolCallId: "task:5",
      request: { operation: "workflow.exec", activationId: "binding", operationId: "operation" },
    } as CandidateToolCommand;
    const dispose = vi.fn();
    bridge.trackWorkflow({ command, completed: () => completed, dispose });
    const abort = {
      seq: 3,
      nextId: 6,
      writes: [
        {
          type: "task",
          value: {
            id: 5,
            kind: "pi.tool",
            abortRequested: true,
            state: { status: "running", checkpoint: { phase: "execute" } },
          },
        },
      ],
    } as DurableSessionCommit;
    const publication = bridge.preparePublication(abort);
    expect(publication.tools).toEqual([]);
    expect(publication.cancellations).toHaveLength(completed ? 0 : 1);
    publication.confirmed();
    expect(bridge.preparePublication(abort).cancellations).toEqual([]);
    const final = bridge.preparePublication({
      ...abort,
      seq: 4,
      writes: [
        {
          type: "task",
          value: { id: 5, kind: "pi.tool", abortRequested: true, state: { status: "terminal" } },
        },
      ],
    });
    final.confirmed();
    expect(dispose).toHaveBeenCalledOnce();
  },
);
