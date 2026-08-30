import {
  decodeWorkspaceSettlement,
  encodeWorkspaceSettlement,
  validateLoadedWorkspaceSettlement,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

const emptyWorkspace = Buffer.from('{"format":"pi-cloud.workspace-seed.v1","files":[]}\n');

describe("Workspace settlement values", () => {
  it("round-trips a bounded Workspace settlement reference", () => {
    const encoded = encodeWorkspaceSettlement(emptyWorkspace);
    expect(decodeWorkspaceSettlement(encoded)).toEqual(emptyWorkspace);
    expect(
      validateLoadedWorkspaceSettlement({
        revision: "revision-1",
        reference: decodeWorkspaceSettlement(encoded),
      }),
    ).toMatchObject({ revision: "revision-1", reference: emptyWorkspace });
  });

  it("rejects a changed Workspace hash", () => {
    const encoded = encodeWorkspaceSettlement(emptyWorkspace);
    expect(() =>
      decodeWorkspaceSettlement({
        ...encoded,
        sha256: "0".repeat(64),
      }),
    ).toThrow(/hash/i);
  });
});
