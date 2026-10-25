import { afterEach, expect, it, vi } from "vitest";
import { ImageGenerationClient } from "../src/ordinary-tools/image-generation-client.ts";
const clients: ImageGenerationClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64");
function client(
  send: NonNullable<ConstructorParameters<typeof ImageGenerationClient>[0]["fetch"]>,
) {
  const result = new ImageGenerationClient({
    baseUrl: "http://fixture",
    apiKey: "test-key",
    model: "gpt-image-2",
    fetch: send,
  });
  clients.push(result);
  return result;
}
it("sends references and alpha through the Images edit API, independently of chat model", async () => {
  const send = vi.fn(async () => Response.json({ data: [{ b64_json: png }] }));
  const result = await client(send).generate(
    { prompt: "Keep the face", images: [{ mimeType: "image/png", data: png }], transparent: true },
    new AbortController().signal,
  );
  expect(result.data).toBe(png);
  expect(send).toHaveBeenCalledTimes(1);
  const [url, request] = send.mock.calls[0] as unknown as [string, { body: string }];
  expect(url).toBe("http://fixture/v1/images/edits");
  expect(JSON.parse(request.body)).toMatchObject({
    model: "gpt-image-2",
    background: "transparent",
    images: [{ image_url: `data:image/png;base64,${png}` }],
  });
});
it("does not retry uncertain transport failures or substitute a credential route", async () => {
  const send = vi.fn(async () => {
    throw new Error("socket lost");
  });
  await expect(
    client(send).generate(
      { prompt: "A face", images: [], transparent: false },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ uncertain: true });
  expect(send).toHaveBeenCalledTimes(1);
});
it("distinguishes a service refusal and rejects a malformed successful reply", async () => {
  await expect(
    client(async () => new Response("refused", { status: 403 })).generate(
      { prompt: "A face", images: [], transparent: false },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ uncertain: false });
  await expect(
    client(async () => Response.json({ data: [] })).generate(
      { prompt: "A face", images: [], transparent: false },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ uncertain: true });
});
it("does not send an already cancelled image request", async () => {
  const send = vi.fn(async () => Response.json({}));
  await expect(
    client(send).generate(
      { prompt: "A face", images: [], transparent: false },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
