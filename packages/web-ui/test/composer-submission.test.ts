import { expect, it } from "vitest";
import { ComposerSubmission } from "../src/composer-submission.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const input = {
  kind: "turn" as const,
  sessionId: "session",
  text: "run once",
  uploadIds: ["image"],
};

it("shows the captured draft before preparation and retains uncertainty until the same-key retry succeeds", async () => {
  const submission = new ComposerSubmission();
  const changes: unknown[] = [];
  const unsubscribe = submission.subscribe(() => changes.push(submission.snapshot()));
  const blocked = deferred();
  let originalKey = "";
  const pending = submission.send(input, async (key) => {
    originalKey = key;
    expect(submission.snapshot()).toMatchObject({ state: "sending", input });
    await blocked.promise;
    throw Error("reply lost");
  });
  expect(submission.snapshot()?.state).toBe("sending");
  blocked.resolve();
  await expect(pending).rejects.toThrow("reply lost");
  expect(submission.snapshot()).toMatchObject({ state: "unconfirmed", input });
  await submission.send(input, async (key) => expect(key).toBe(originalKey));
  expect(submission.snapshot()).toBeNull();
  expect(changes).toHaveLength(4);
  unsubscribe();
});

it("a late failure cannot replace the feedback for a newer draft", async () => {
  const submission = new ComposerSubmission(),
    blocked = deferred();
  const first = submission.send(input, async () => {
    await blocked.promise;
    throw Error("old failure");
  });
  const newer = { ...input, text: "new draft" };
  await expect(
    submission.send(newer, async () => {
      throw Error("new failure");
    }),
  ).rejects.toThrow();
  blocked.resolve();
  await expect(first).rejects.toThrow("old failure");
  expect(submission.snapshot()).toMatchObject({ state: "unconfirmed", input: newer });
});

it.each(["turn", "compact"] as const)(
  "%s retries a lost ACK but permits an intentional repeat after confirmation",
  async (kind) => {
    const submission = new ComposerSubmission(),
      accepted = new Map<string, string>();
    const request = { ...input, kind };
    let loseReply = true;
    const server = async (key: string) => {
      if (!accepted.has(key)) accepted.set(key, `input-${accepted.size}`);
      if (loseReply) {
        loseReply = false;
        throw new Error("reply lost after commit");
      }
      return accepted.get(key);
    };
    await expect(submission.send(request, server)).rejects.toThrow("reply lost");
    expect(await submission.send({ ...request, uploadIds: [...input.uploadIds] }, server)).toBe(
      "input-0",
    );
    expect(accepted.size).toBe(1);
    expect(await submission.send(request, server)).toBe("input-1");
    expect(accepted.size).toBe(2);
  },
);

it.each([
  { ...input, text: "different task" },
  { ...input, sessionId: "another session" },
  { ...input, uploadIds: ["another image"] },
  { ...input, whenBusy: "steer" as const },
  { ...input, kind: "compact" as const },
])("assigns a new identity when the submitted input changes: %j", async (changed) => {
  const submission = new ComposerSubmission(),
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
  const submission = new ComposerSubmission();
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

it.each(["turn", "compact"] as const)(
  "ends uncertain %s identity after the other action succeeds",
  async (kind) => {
    const submission = new ComposerSubmission();
    const request = { ...input, kind };
    let oldKey = "";
    await expect(
      submission.send(request, async (key) => {
        oldKey = key;
        throw new Error("accepted but reply lost");
      }),
    ).rejects.toThrow();
    await submission.send(
      { ...input, kind: kind === "turn" ? "compact" : "turn", text: "another instruction" },
      async () => {},
    );
    const freshKey = await submission.send(request, async (key) => key);
    expect(freshKey).not.toBe(oldKey);
  },
);

it("explicit abandonment ends an uncertain intent without letting its late ACK clear a new one", async () => {
  const submission = new ComposerSubmission();
  let acknowledge!: () => void;
  const ack = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let firstKey = "";
  const first = submission.send(input, async (key) => {
    firstKey = key;
    await ack;
  });
  submission.reset();
  let newKey = "";
  await expect(
    submission.send(input, async (key) => {
      newKey = key;
      throw new Error("lost");
    }),
  ).rejects.toThrow();
  expect(newKey).not.toBe(firstKey);
  acknowledge();
  await first;
  expect(await submission.send(input, async (key) => key)).toBe(newKey);
});

it.each(["turn", "steer"] as const)(
  "retires only the returned %s identity, preserving an unrelated Session or newer intent",
  async (mode) => {
    const submission = new ComposerSubmission(),
      request = { ...input, ...(mode === "steer" ? { whenBusy: "steer" as const } : {}) };
    const keys: string[] = [];
    const lost = async (key: string) => {
      keys.push(key);
      throw new Error("reply lost");
    };
    await expect(submission.send(request, lost)).rejects.toThrow();
    submission.retireReturned("another-session", [keys[0]!]);
    await expect(submission.send(request, lost)).rejects.toThrow();
    expect(keys[1]).toBe(keys[0]);
    submission.retireReturned(input.sessionId, [keys[0]!]);
    await expect(submission.send(request, lost)).rejects.toThrow();
    expect(keys[2]).not.toBe(keys[0]);
    // A repeated/late old return cannot erase the new request's lost ACK.
    submission.retireReturned(input.sessionId, [keys[0]!]);
    await expect(submission.send(request, lost)).rejects.toThrow();
    expect(keys[3]).toBe(keys[2]);
  },
);

it("a late acknowledgement of a returned input cannot clear its resubmission", async () => {
  const submission = new ComposerSubmission();
  let acknowledge!: () => void;
  const ack = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let oldKey = "",
    newKey = "";
  const first = submission.send(input, async (key) => {
    oldKey = key;
    await ack;
  });
  submission.retireReturned(input.sessionId, [oldKey]);
  await expect(
    submission.send(input, async (key) => {
      newKey = key;
      throw Error("lost");
    }),
  ).rejects.toThrow();
  acknowledge();
  await first;
  expect(newKey).not.toBe(oldKey);
  expect(await submission.send(input, async (key) => key)).toBe(newKey);
});
