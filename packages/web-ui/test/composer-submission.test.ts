import { expect, it } from "vitest";
import { ComposerSubmission } from "../src/composer-submission.ts";

const input = { sessionId: "session", text: "run once", uploadIds: ["image"] };

it.each(["turn", "steer"] as const)(
  "%s retries a lost ACK but permits an intentional repeat after confirmation",
  async (kind) => {
    const submission = new ComposerSubmission(kind),
      accepted = new Map<string, string>();
    let loseReply = true;
    const server = async (key: string) => {
      if (!accepted.has(key)) accepted.set(key, `input-${accepted.size}`);
      if (loseReply) {
        loseReply = false;
        throw new Error("reply lost after commit");
      }
      return accepted.get(key);
    };
    await expect(submission.send(input, server)).rejects.toThrow("reply lost");
    expect(await submission.send({ ...input, uploadIds: [...input.uploadIds] }, server)).toBe(
      "input-0",
    );
    expect(accepted.size).toBe(1);
    expect(await submission.send(input, server)).toBe("input-1");
    expect(accepted.size).toBe(2);
  },
);

it.each([
  { ...input, text: "different task" },
  { ...input, sessionId: "another session" },
  { ...input, uploadIds: ["another image"] },
  { ...input, targetTurnId: "another target" },
])("assigns a new identity when the submitted input changes: %j", async (changed) => {
  const submission = new ComposerSubmission("turn"),
    keys: string[] = [];
  const lost = async (key: string) => {
    keys.push(key);
    throw new Error("uncertain");
  };
  await expect(submission.send(input, lost)).rejects.toThrow();
  await expect(submission.send(changed, lost)).rejects.toThrow();
  expect(keys[0]).not.toBe(keys[1]);
});

it("does not let an older acknowledgement discard an unresolved newer submission", async () => {
  const submission = new ComposerSubmission("turn");
  let acknowledge!: () => void;
  const first = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const old = submission.send(input, () => first);
  const changed = { ...input, text: "new input" },
    keys: string[] = [];
  const send = async (key: string) => {
    keys.push(key);
    if (keys.length === 1) throw new Error("lost");
  };
  await expect(submission.send(changed, send)).rejects.toThrow();
  acknowledge();
  await old;
  await submission.send(changed, send);
  expect(keys[0]).toBe(keys[1]);
});
