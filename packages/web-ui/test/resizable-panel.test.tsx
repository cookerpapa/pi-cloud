import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useResizablePanel } from "../src/use-resizable-panel.ts";

function Panel() {
  const panel = useResizablePanel({
    storageKey: "test-panel",
    initialWidth: 280,
    minimumWidth: 180,
    maximumWidth: 600,
  });
  return <div data-width={panel.width} data-collapsed={panel.collapsed} />;
}

afterEach(() => vi.unstubAllGlobals());

it.each([null, "", "NaN", "280"])(
  "uses the configured initial width for a missing/invalid preference %s",
  (stored) => {
    vi.stubGlobal("localStorage", { getItem: () => stored });
    expect(renderToStaticMarkup(<Panel />)).toContain('data-width="280"');
  },
);

it("restores and clamps a saved width", () => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key.endsWith(":width") ? "700" : "true"),
  });
  const markup = renderToStaticMarkup(<Panel />);
  expect(markup).toContain('data-width="600"');
  expect(markup).toContain('data-collapsed="true"');
});
