import { describe, expect, it } from "vitest";
import {
  issuePreviewAccessToken,
  previewOriginHostname,
  previewSecurityHeaders,
  rewritePreviewHtml,
  verifyPreviewAccessToken,
} from "../src/sandbox-preview-gateway.ts";

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

  it("allows same-origin application APIs only on a separate Preview origin", () => {
    const headers = previewSecurityHeaders("nonce-value");
    expect(headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(headers["content-security-policy"]).toContain("allow-same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  it("derives a stable isolated hostname per target and application port", () => {
    const secret = "preview-secret-value-with-at-least-32-bytes";
    const target = {
      kind: "conversation" as const,
      sessionId: "10000000-0000-4000-8000-000000000001",
    };
    const first = previewOriginHostname(secret, "preview.localhost", target, 8_000);
    expect(first).toMatch(/^p-[0-9a-f]{24}\.preview\.localhost$/u);
    expect(previewOriginHostname(secret, "preview.localhost", target, 8_000)).toBe(first);
    expect(previewOriginHostname(secret, "preview.localhost", target, 3_000)).not.toBe(first);
  });

  it("scopes isolated-origin subresource authority to one user, target, port and expiry", () => {
    const secret = "preview-secret-value-with-at-least-32-bytes";
    const now = Date.parse("2026-08-24T00:00:00.000Z");
    const target = {
      kind: "conversation" as const,
      sessionId: "10000000-0000-4000-8000-000000000001",
    };
    const token = issuePreviewAccessToken(
      secret,
      {
        tenantId: "20000000-0000-4000-8000-000000000002",
        userId: "30000000-0000-4000-8000-000000000003",
        target,
        port: 4_173,
      },
      now,
    );
    expect(verifyPreviewAccessToken(secret, token, target, 4_173, now)).toEqual({
      tenantId: "20000000-0000-4000-8000-000000000002",
      userId: "30000000-0000-4000-8000-000000000003",
    });
    expect(
      verifyPreviewAccessToken(
        secret,
        `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
        target,
        4_173,
        now,
      ),
    ).toBeUndefined();
    expect(verifyPreviewAccessToken(secret, token, target, 8_000, now)).toBeUndefined();
    expect(
      verifyPreviewAccessToken(
        secret,
        token,
        { ...target, sessionId: "40000000-0000-4000-8000-000000000004" },
        4_173,
        now,
      ),
    ).toBeUndefined();
    expect(
      verifyPreviewAccessToken(secret, token, target, 4_173, now + 15 * 60_000),
    ).toBeUndefined();
  });
});
