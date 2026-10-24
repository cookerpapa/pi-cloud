import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionImage, isSessionImagePath } from "../src/SessionImage.tsx";
import { Markdown } from "../src/Markdown.tsx";
const path =
  "/v1/sessions/10000000-0000-4000-8000-000000000001/images/10000000-0000-4000-8000-000000000002";
it("renders retained same-origin image links in an answer", () => {
  const html = renderToStaticMarkup(<Markdown>{`![角色设定](${path})`}</Markdown>);
  expect(html).toContain(`<img src="${path}"`);
  expect(html).toContain('loading="lazy"');
  expect(html).toContain('alt="角色设定"');
});
it("keeps unrelated or external image URLs outside the authenticated image renderer", () => {
  expect(isSessionImagePath("https://elsewhere.example/image.png")).toBe(false);
  expect(isSessionImagePath(`${path}?token=unexpected`)).toBe(false);
  expect(
    renderToStaticMarkup(<SessionImage src="//elsewhere.example/image.png" alt="external" />),
  ).toBe("");
});
