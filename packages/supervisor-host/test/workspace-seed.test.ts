import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import { parseWorkspaceSeed } from "@pi-cloud/workspace-runtime";
import { expect, it } from "vitest";
import { resolveWorkspaceSeed } from "../src/workspace-seed.ts";

it.each(["empty", "sample_java"] as const)(
  "uses the claimed %s seed without another DB read",
  async (workspaceSeedKind) => {
    const command = { payload: { workspaceSeedKind } } as ExecuteTurnCommandMessage;
    const bytes = await resolveWorkspaceSeed(command, new AbortController().signal);
    if (workspaceSeedKind === "empty") expect(parseWorkspaceSeed(bytes!)).toEqual([]);
    else expect(bytes).toBeUndefined();
  },
);

it("does not materialize a seed after cancellation", async () => {
  const command = { payload: { workspaceSeedKind: "empty" } } as ExecuteTurnCommandMessage;
  const controller = new AbortController();
  controller.abort();
  await expect(resolveWorkspaceSeed(command, controller.signal)).rejects.toMatchObject({
    code: "workspace_seed_cancelled",
  });
});
