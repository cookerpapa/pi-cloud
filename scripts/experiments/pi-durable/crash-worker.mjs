import { JournalStorage } from "./journal.mjs";
import { openHarness, ctx, answer, call } from "./harness.mjs";
const replies = new Map();
let sequence = 0;
process.on("message", async (message) => {
  if (message.type === "ack") {
    const wait = replies.get(message.id);
    replies.delete(message.id);
    if (message.error) wait?.reject(new Error(message.error));
    else wait?.resolve();
    return;
  }
  if (message.type !== "start") return;
  try {
    const store = new JournalStorage(async (batch) => {
      const wait = Promise.withResolvers(),
        id = ++sequence;
      replies.set(id, wait);
      process.send({ type: "commit", id, batch });
      await wait.promise;
    });
    const { root } = await openHarness(store, {
      replay: message.replay,
      responses: [
        answer(call("remote", { value: "effect" }), { stopReason: "toolUse" }),
        async () => new Promise(() => {}),
      ],
      execute: async () => {
        process.send({ type: "effect" });
        if (message.complete) return { content: [{ type: "text", text: "COMMITTED_RESULT" }] };
        return new Promise(() => {});
      },
    });
    const submitted = await root.submit(
      { type: "input", content: "Do the probe", requestId: "crash-input" },
      ctx,
    );
    process.send({ type: "submission", id: submitted.id });
    await submitted.wait(ctx);
  } catch (error) {
    process.send({ type: "failure", message: error.message });
    process.exitCode = 1;
  }
});
