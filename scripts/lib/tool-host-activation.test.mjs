import { expect, it, vi } from "vitest";
import { activateToolHost, verifyToolHostRouteInCluster } from "./tool-host-activation.mjs";

const pod = (image = "new", uid = "new") => ({
  metadata: { uid },
  status: {
    phase: "Running",
    podIP: "127.0.0.1",
  },
  spec: { containers: [{ name: "tool-host", image }] },
});

it("activates only the selected image and uses a generation precondition", async () => {
  const request = vi.fn(async (url, init) =>
    url.endsWith("/manifest")
      ? Response.json({
          releaseId: "code-b",
          catalog: { revision: "digest" },
          selected: { generation: 7 },
        })
      : Response.json({ generation: 8, revision: "digest" }),
  );
  const value = await activateToolHost({
    pods: async () => [pod("old", "old"), pod()],
    token: "test",
    expectedImage: "new",
    request,
  });
  expect(value).toEqual({ releaseId: "code-b", generation: 8, revision: "digest" });
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({
    releaseId: "code-b",
    revision: "digest",
    expectedGeneration: 7,
  });
});

it("reconciles a lost activation acknowledgement from the next manifest", async () => {
  let selected = 1,
    lost = false;
  const request = vi.fn(async (url) => {
    if (url.endsWith("/manifest"))
      return Response.json({
        releaseId: "code-b",
        catalog: { revision: "digest" },
        selected: { generation: selected },
      });
    selected = 2;
    if (!lost) {
      lost = true;
      throw new Error("reply lost after selection");
    }
    return Response.json({ generation: 2, revision: "digest" });
  });
  const value = await activateToolHost({
    pods: async () => [pod()],
    token: "test",
    expectedImage: "new",
    request,
    pause: async () => {},
  });
  expect(value.generation).toBe(2);
  expect(JSON.parse(request.mock.calls[3][1].body).expectedGeneration).toBe(2);
});

it.each(["reachable", "blocked", "wrong-release"])(
  "checks the route from each actual Session runtime (%s)",
  async (mode) => {
    const kubectl = vi.fn(async (args) => {
      if (args[0] === "get")
        return JSON.stringify({
          items: [{ metadata: { name: "session-pod" }, status: { phase: "Running" } }],
        });
      expect(args.slice(0, 4)).toEqual(["exec", "session-pod", "-c", "session-runtime"]);
      if (mode === "blocked") throw Error("ECONNREFUSED");
      return JSON.stringify({ releaseId: mode === "wrong-release" ? "old" : "new", generation: 2 });
    });
    const result = verifyToolHostRouteInCluster({ kubectl, releaseId: "new" });
    if (mode === "reachable")
      await expect(result).resolves.toEqual({ verified: true, sessionRuntimes: 1 });
    else await expect(result).rejects.toThrow(mode === "blocked" ? "ECONNREFUSED" : "another Tool");
  },
);
