import { describe, expect, it } from "vitest";
import { classifyAuditFindings } from "./dependency-audit.mjs";

const node = "node_modules/@earendil-works/pi-coding-agent/node_modules/undici";
const replacements = new Map([["undici", { node, version: "8.10.2" }]]);
const installed = (path) => (path === node ? "8.10.2" : "1.0.0");
function report(range = ">=8.0.0 <8.10.2", nodes = [node]) {
  return {
    "@earendil-works/pi-coding-agent": { name: "@earendil-works/pi-coding-agent", via: ["undici"] },
    undici: {
      name: "undici",
      nodes,
      severity: "high",
      via: [{ url: "https://example.invalid/advisory", range }],
    },
  };
}
describe("installed shrinkwrap audit evidence", () => {
  it("distinguishes the verified installed patch from stale bundled metadata", () => {
    const result = classifyAuditFindings(report(), replacements, installed);
    expect(result.remaining).toEqual([]);
    expect(result.remediated.map((f) => f.name)).toEqual([
      "undici",
      "@earendil-works/pi-coding-agent",
    ]);
  });
  it.each([">=8.0.0 <8.10.3", "not-a-range", undefined])(
    "keeps a new, unknown or still-applicable advisory visible: %s",
    (range) => {
      const input = report();
      input.undici.via[0].range = range;
      const result = classifyAuditFindings(input, replacements, installed);
      expect(result.remediated).toEqual([]);
      expect(result.remaining).toHaveLength(2);
    },
  );
  it("does not exempt another affected installation or an unprepared dependency", () => {
    expect(
      classifyAuditFindings(
        report("<8.10.2", [node, "node_modules/undici"]),
        replacements,
        installed,
      ).remediated,
    ).toEqual([]);
    expect(classifyAuditFindings(report(), replacements, () => "8.10.0").remediated).toEqual([]);
  });
  it("does not exempt direct Pi advisories along with a patched dependency", () => {
    const input = report();
    input["@earendil-works/pi-coding-agent"].via.push({
      url: "https://example.invalid/pi",
      range: "<1.0.0",
    });
    expect(
      classifyAuditFindings(input, replacements, installed).remaining.map((f) => f.name),
    ).toEqual(["@earendil-works/pi-coding-agent"]);
  });
});
