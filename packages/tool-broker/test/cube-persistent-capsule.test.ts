import { describe, expect, it } from "vitest";
import { CubePersistentCapsuleCodec } from "../src/cube-persistent-capsule.ts";

describe("encrypted Cube persistent-machine capsule", () => {
  it("round-trips bounded state and rejects tampering or the wrong key", () => {
    const codec = new CubePersistentCapsuleCodec(Buffer.alloc(32, 7));
    const capsule = codec.seal({ runtime: "cube-1", secret: "not-plaintext" });
    expect(capsule).not.toContain("not-plaintext");
    expect(codec.open(capsule)).toEqual({ runtime: "cube-1", secret: "not-plaintext" });
    expect(() => codec.open(`${capsule.slice(0, -1)}A`)).toThrow(/authentication|invalid/u);
    expect(() => new CubePersistentCapsuleCodec(Buffer.alloc(32, 8)).open(capsule)).toThrow(
      /authentication/u,
    );
  });
});
