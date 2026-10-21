import { expect, it } from "vitest";
import { runtimeCapabilityState } from "./runtime-capability-acceptance.mjs";

it("retains unchanged settings across Runs and isolates child configuration and withdrawal", () => {
  const row = (conversationId, ...model) => ({ entry: { conversationId, model } });
  const tool = (name) => ({ name, description: name, parameters: { type: "object" } });
  const rows = [
    row(1, {
      role: "system",
      content: "",
      sections: { "cloud-network": "enabled", "delegation-policy": "explicit" },
      toolsAdded: [tool("bash"), tool("preview")],
    }),
    row(1, { role: "user", content: "A later Run reuses unchanged network/tool state" }),
    row(1, { role: "system", content: "", sections: { "delegation-policy": "proactive" } }),
    row(2, {
      role: "system",
      content: "",
      sections: { "cloud-network": "unknown", "delegation-policy": "explicit" },
      toolsAdded: [tool("read")],
    }),
  ];
  expect(runtimeCapabilityState(rows, "1")).toEqual({
    sections: { "cloud-network": "enabled", "delegation-policy": "proactive" },
    tools: ["bash", "preview"],
  });
  rows.push(
    row(1, {
      role: "system",
      content: "",
      sections: { "delegation-policy": "explicit", "cloud-network": null },
      toolsRemoved: [{ name: "preview" }],
    }),
  );
  expect(runtimeCapabilityState(rows, 1)).toEqual({
    sections: { "delegation-policy": "explicit" },
    tools: ["bash"],
  });
  expect(runtimeCapabilityState(rows, 2).tools).toEqual(["read"]);
});
