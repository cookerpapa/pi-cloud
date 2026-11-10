import { expect, it, vi } from "vitest";
import { retireCubeExtensionTables } from "./retire-cube-extension-tables.mjs";
function fixture() {
  const state = { image: "pi-cloud/cube-master:stock-test" };
  const kubectl = vi.fn((args, options) => {
    if (args[0] === "exec") {
      expect(options.input).not.toContain("DROP TABLE t_volume");
      return "";
    }
    if (args[1] === "statefulset")
      return JSON.stringify({
        spec: {
          template: {
            spec: { containers: [{ env: [{ name: "MYSQL_DATABASE", value: "cube_fixture" }] }] },
          },
        },
      });
    return JSON.stringify({
      items: [
        { metadata: {}, spec: { containers: [{ name: "cube-master", image: state.image }] } },
        {
          metadata: {},
          spec: { containers: [{ name: "cubelet", image: "pi-cloud/cubelet:stock-test" }] },
        },
      ],
    });
  });
  return {
    state,
    kubectl,
    options: {
      kubectl,
      tag: "stock-test",
      assertDrained: async () => {},
      assertNativeAbsent: async () => {},
    },
  };
}
it("refuses cleanup while an old native writer exists or physical retirement is unknown", async () => {
  const f = fixture();
  f.state.image = "pi-cloud/cube-master:old";
  await expect(retireCubeExtensionTables(f.options)).rejects.toThrow("old Cube writer");
  expect(f.kubectl.mock.calls.some(([args]) => args[0] === "exec")).toBe(false);
  await expect(
    retireCubeExtensionTables({
      ...f.options,
      assertNativeAbsent: async () => {
        throw new Error("absence unknown");
      },
    }),
  ).rejects.toThrow("absence unknown");
});
it("removes only the five retired extension tables and their exact migration versions", async () => {
  const f = fixture();
  expect(await retireCubeExtensionTables(f.options)).toMatchObject({
    nativeExtensionTablesRetired: 5,
  });
  const [args, options] = f.kubectl.mock.calls.find(([args]) => args[0] === "exec");
  expect(args.at(-1)).toBe("cube_fixture");
  expect(options.input.match(/DROP TABLE IF EXISTS/g)).toHaveLength(5);
  expect(options.input).toContain("20261004000000,20261005000000");
  expect(options.input).not.toMatch(/DROP DATABASE|TRUNCATE|t_volume;/);
});
