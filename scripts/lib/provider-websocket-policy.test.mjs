import { expect, it } from "vitest";
import { ensureProviderWebsocketAccounts } from "./provider-websocket-policy.mjs";

it("enables native upstream transport without changing credentials, disabled state or other providers", async () => {
  const files = [
    { name: "one", provider: "codex", auth_index: "a", disabled: true },
    { name: "two", provider: "codex", websockets: true },
    { name: "three", provider: "deepseek" },
  ];
  const patches = [];
  const fetchImplementation = async (_url, init) => {
    expect(init.headers.authorization).toBe("Bearer private-key");
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body);
      patches.push(body);
      files.find((file) => file.name === body.name).websockets = body.websockets;
      return Response.json({ status: "ok" });
    }
    return Response.json({ files });
  };
  const run = () =>
    ensureProviderWebsocketAccounts({
      baseUrl: "http://provider",
      managementKey: "private-key",
      fetchImplementation,
    });
  expect(await run()).toEqual({ codexAccounts: 2, updated: 1, upstreamWebsocketEnabled: true });
  expect(patches).toEqual([{ name: "one", auth_index: "a", websockets: true }]);
  expect(files[0].disabled).toBe(true);
  expect(files[2].websockets).toBeUndefined();
  expect((await run()).updated).toBe(0);
});

it("requires provider confirmation instead of claiming local WebSocket support is sufficient", async () => {
  const fetchImplementation = async (_url, init) =>
    Response.json(
      init.method === "PATCH" ? { status: "ok" } : { files: [{ name: "one", provider: "codex" }] },
    );
  await expect(
    ensureProviderWebsocketAccounts({
      baseUrl: "http://provider",
      managementKey: "private-key",
      fetchImplementation,
    }),
  ).rejects.toThrow("did not confirm");
});

it("verifies without silently changing provider settings during acceptance", async () => {
  let patches = 0;
  const fetchImplementation = async (_url, init) => {
    if (init.method === "PATCH") patches++;
    return Response.json({ files: [{ name: "one", provider: "codex", websockets: false }] });
  };
  await expect(
    ensureProviderWebsocketAccounts({
      baseUrl: "http://provider",
      managementKey: "private-key",
      verifyOnly: true,
      fetchImplementation,
    }),
  ).rejects.toThrow("must enable upstream");
  expect(patches).toBe(0);
});
