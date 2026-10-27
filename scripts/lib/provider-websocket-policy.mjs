import assert from "node:assert/strict";

/** CLIProxyAPI owns account metadata. Enabling its downstream WebSocket route
 * alone does not enable upstream continuation: HTTP mode expands each input. */
export async function ensureProviderWebsocketAccounts({
  baseUrl,
  managementKey,
  verifyOnly = false,
  fetchImplementation = fetch,
}) {
  const call = async (path, body) => {
    const response = await fetchImplementation(new URL(path, baseUrl), {
      method: body ? "PATCH" : "GET",
      headers: {
        authorization: `Bearer ${managementKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    assert(
      response.ok,
      `Provider account transport configuration returned HTTP ${response.status}`,
    );
    return response.json();
  };
  const list = async () => {
    const result = await call("/v0/management/auth-files");
    assert(Array.isArray(result.files), "Provider account inventory is unavailable");
    return result.files.filter((file) => (file.provider ?? file.type) === "codex");
  };
  const accounts = await list();
  if (verifyOnly) {
    assert(
      accounts.every((account) => account.websockets === true),
      "Provider accounts must enable upstream WebSockets before continuation acceptance",
    );
    return { codexAccounts: accounts.length, updated: 0, upstreamWebsocketEnabled: true };
  }
  let updated = 0;
  for (const account of accounts) {
    assert(
      typeof account.name === "string" && account.name.length,
      "Provider account identity is missing",
    );
    if (account.websockets === true) continue;
    await call("/v0/management/auth-files/fields", {
      name: account.name,
      ...(account.auth_index ? { auth_index: account.auth_index } : {}),
      websockets: true,
    });
    updated++;
  }
  const current = await list();
  assert(
    current.length >= accounts.length && current.every((file) => file.websockets === true),
    "Provider did not confirm upstream WebSocket eligibility",
  );
  // No account names, tokens or credential JSON in operator output.
  return { codexAccounts: current.length, updated, upstreamWebsocketEnabled: true };
}
