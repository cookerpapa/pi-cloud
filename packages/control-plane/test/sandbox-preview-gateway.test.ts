import { describe, expect, it } from "vitest";
import { rewritePreviewHtml } from "../src/sandbox-preview-gateway.ts";

describe("SandboxPreviewGateway HTML policy", () => {
  it("adds a Preview base and nonces inline code without changing external scripts", () => {
    const html = Buffer.from(
      '<!doctype html><html><head><style>body{color:red}</style></head><body><script>window.game=true</script><script src="game.js"></script></body></html>',
    );
    const rewritten = rewritePreviewHtml(
      html,
      "/v1/conversations/session/preview/8000",
      "nonce-value",
    ).toString("utf8");
    expect(rewritten).toContain('<base href="/v1/conversations/session/preview/8000/">');
    expect(rewritten).toContain('<style nonce="nonce-value">');
    expect(rewritten).toContain('<script nonce="nonce-value">window.game=true</script>');
    expect(rewritten).toContain('<script src="game.js"></script>');
  });
});
