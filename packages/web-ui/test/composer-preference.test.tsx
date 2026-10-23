import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerEnterMode } from "../src/useComposerEnterMode.tsx";

function Preference({
  userId = "one",
  tenantId = "tenant",
}: {
  userId?: string;
  tenantId?: string;
}) {
  const { enterMode } = useComposerEnterMode({ userId, tenantId });
  return <span>{enterMode}</span>;
}
afterEach(() => vi.unstubAllGlobals());

it.each([null, "", "invalid", "follow_up"])("defaults to follow-up for %s", (saved) => {
  vi.stubGlobal("localStorage", { getItem: () => saved });
  expect(renderToStaticMarkup(<Preference />)).toContain("follow_up");
});

it("scopes the preference to the account and tenant, independent of the Session", () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === "pi-cloud:composer-enter:tenant:one" ? "steer" : null),
  });
  expect(renderToStaticMarkup(<Preference />)).toContain("steer");
  expect(renderToStaticMarkup(<Preference userId="two" />)).toContain("follow_up");
  expect(renderToStaticMarkup(<Preference tenantId="other" />)).toContain("follow_up");
});

it("keeps chat usable when storage is blocked", () => {
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("Storage is unavailable");
    },
  });
  expect(renderToStaticMarkup(<Preference />)).toContain("follow_up");
});
