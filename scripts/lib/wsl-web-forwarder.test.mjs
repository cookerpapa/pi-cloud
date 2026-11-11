import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { release } from "node:os";
import { runWslWebAsRuntimeOwner } from "./wsl-web-forwarder.mjs";
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ statSync: vi.fn() }));
vi.mock("node:os", () => ({ release: vi.fn(), homedir: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const input = { runtimeDirectory: "/runtime", script: "/repo/scripts/production-kubernetes.mjs" };
it("uses the existing runtime owner's service manager during privileged WSL maintenance", () => {
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.mocked(release).mockReturnValue("linux-microsoft-WSL2");
  vi.mocked(statSync).mockReturnValue({ uid: 1000 });
  vi.mocked(execFileSync)
    .mockReset()
    .mockReturnValueOnce("operator:x:1000:1000::/home/operator:/bin/bash\n");
  expect(runWslWebAsRuntimeOwner(input)).toBe(true);
  const [binary, args] = vi.mocked(execFileSync).mock.calls[1];
  expect(binary).toBe("runuser");
  expect(args.slice(0, 4)).toEqual(["--user", "operator", "--", "/usr/bin/env"]);
  expect(args).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus");
  expect(args.slice(-3)).toEqual([process.execPath, input.script, "local-web"]);
});
it("does not change execution identity for an ordinary user or a non-WSL host", () => {
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  vi.mocked(release).mockReturnValue("linux-microsoft-WSL2");
  vi.mocked(execFileSync).mockReset();
  expect(runWslWebAsRuntimeOwner(input)).toBe(false);
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.mocked(release).mockReturnValue("linux");
  expect(runWslWebAsRuntimeOwner(input)).toBe(false);
  expect(execFileSync).not.toHaveBeenCalled();
});
it("refuses an account lookup that does not match the retained credential owner", () => {
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.mocked(release).mockReturnValue("linux-microsoft-WSL2");
  vi.mocked(statSync).mockReturnValue({ uid: 1000 });
  vi.mocked(execFileSync)
    .mockReset()
    .mockReturnValueOnce("other:x:2000:2000::/home/other:/bin/bash");
  expect(() => runWslWebAsRuntimeOwner(input)).toThrow("Runtime owner is unavailable");
  expect(execFileSync).toHaveBeenCalledTimes(1);
});
