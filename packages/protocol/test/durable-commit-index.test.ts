import { expect, it } from "vitest";
import {
  DurableCommitIndex,
  durableToolIntent,
  type DurableSessionCommit,
} from "../src/durable-session.ts";

it("shares lookup across a batch without losing the order of repeated native writes", () => {
  const task = (id: number, command: string) => ({
    type: "task",
    value: {
      id,
      kind: "pi.tool",
      abortRequested: false,
      input: { callId: `call-${id}` },
      state: { checkpoint: { phase: "execute", arguments: { command } } },
    },
  });
  const commit: DurableSessionCommit = {
    seq: 1,
    nextId: 102,
    writes: [
      task(4, "first"),
      task(4, "later"),
      ...Array.from({ length: 95 }, (_, i) => task(5 + i, String(i))),
    ],
  };
  const index = new DurableCommitIndex(commit);
  Object.defineProperty(commit.writes, "find", {
    value: () => {
      throw Error("No repeated scan");
    },
  });
  expect(durableToolIntent(commit, 4, index).arguments).toEqual({ command: "first" });
  for (let id = 5; id < 100; id++)
    expect(durableToolIntent(commit, id, index).callId).toBe(`call-${id}`);
  expect(commit.writes).toHaveLength(97);
  expect(() => durableToolIntent({ ...commit }, 4, index)).toThrow("another commit");
});
