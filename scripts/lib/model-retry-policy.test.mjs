import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyModelRetryPolicy, updateModelRetryPolicyFile } from "./model-retry-policy.mjs";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("deployment-owned model retry policy", () => {
  it("updates an existing private configuration atomically and is repeatable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-retry-policy-"));
    try {
      const path = join(directory, "config.yaml");
      await writeFile(path, "port: 8317\nrequest-retry: 3\napi-keys: [fixture-key]\n", {
        mode: 0o600,
      });
      expect(await updateModelRetryPolicyFile(path)).toBe(true);
      expect(await updateModelRetryPolicyFile(path)).toBe(false);
      expect(parse(await readFile(path, "utf8"))).toMatchObject({
        "request-retry": 0,
        "api-keys": ["fixture-key"],
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes additional rounds without changing credentials, account routing or comments", () => {
    const source =
      "# operator configuration\nport: 8317\nrequest-retry: 3\napi-keys: [fixture-key]\nrouting:\n  session-affinity: true\n";
    const changed = applyModelRetryPolicy(source);
    expect(parse(changed)).toEqual({ ...parse(source), "request-retry": 0 });
    expect(changed).toContain("# operator configuration");
    expect(applyModelRetryPolicy(changed)).toBe(changed);
  });
  it("fails safely on malformed configuration", () => {
    expect(() => applyModelRetryPolicy("private: [")).toThrow(
      "Provider Gateway configuration is invalid",
    );
  });
});
