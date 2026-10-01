import { expect, it } from "vitest";
import { executionCgroupPath } from "../src/execution-cgroup.ts";

const operation = "aabbccdd-1122-3344-5566-778899aabbcc";
it("keeps each operation beneath the native executor's existing resource cgroup", () => {
  expect(executionCgroupPath(operation, "0::/default/container\n")).toBe(
    `/sys/fs/cgroup/default/container/pi-cloud-tools/${operation}`,
  );
  expect(executionCgroupPath(operation, "0::/\n")).toBe(
    `/sys/fs/cgroup/pi-cloud-tools/${operation}`,
  );
});

it.each(["1:freezer:/container\n", "0::/../other\n", "0::relative\n", "0::/escaped\\name\n"])(
  "does not guess a scope for unsupported or ambiguous membership %s",
  (membership) => {
    expect(() => executionCgroupPath(operation, membership)).toThrow();
  },
);
it("rejects non-operation paths before selecting a control file", () => {
  expect(() => executionCgroupPath("../sibling", "0::/user\n")).toThrow();
});
