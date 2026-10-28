import { afterEach, expect, it, vi } from "vitest";
import { ImageGenerationClient } from "../src/ordinary-tools/image-generation-client.ts";
const clients: ImageGenerationClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

const input = { prompt: "A landscape", images: [], transparent: false };
it("preserves the provider's moderation reason and output stage without retrying", async () => {
  const send = vi.fn(async () =>
    Response.json(
      {
        error: {
          message: "Your request was rejected by the safety system.",
          type: "image_generation_user_error",
          code: "moderation_blocked",
          moderation_details: { moderation_stage: "output", categories: ["sexual"] },
        },
      },
      { status: 400 },
    ),
  );
  const error = await client(send)
    .generate(input, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ uncertain: false });
  expect((error as Error).message).toContain('"code":"moderation_blocked"');
  expect((error as Error).message).toContain("rejected by the safety system");
  expect((error as Error).message).toContain('"moderationStage":"output"');
  expect((error as Error).message).toContain('"moderationCategories":["sexual"]');
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([
  [400, "invalid_parameter", false],
  [429, "rate_limit_exceeded", false],
  [503, "service_unavailable", true],
])("keeps HTTP %s diagnostics separate from outcome certainty", async (status, code, uncertain) => {
  const error = await client(async () =>
    Response.json(
      { error: { code, message: "Provider explanation", param: "quality" } },
      { status },
    ),
  )
    .generate(input, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ uncertain });
  expect((error as Error).message).toContain(`HTTP ${status}`);
  expect((error as Error).message).toContain(`"code":"${code}"`);
  expect((error as Error).message).toContain('"parameter":"quality"');
  expect((error as Error).message).toContain("Provider explanation");
});

it("filters response fields and redacts credentials/image data before exposing error text", async () => {
  const error = await client(async () =>
    Response.json(
      {
        error: {
          message:
            "Invalid key test-key; Bearer opaque-upstream-token; sk-upstream-secret; api_key=another-secret; image data:image/png;base64,aGVsbG8=",
          authorization: "hidden-auth-field",
          request: { prompt: "private-prompt", image: "hidden-image-field" },
        },
        headers: { authorization: "hidden-header-field" },
      },
      { status: 401 },
    ),
  )
    .generate(input, new AbortController().signal)
    .catch((error: unknown) => error);
  const message = (error as Error).message;
  expect(message).toContain("Invalid key");
  expect(message).toContain("[redacted]");
  expect(message).toContain("[image data omitted]");
  for (const value of [
    "test-key",
    "opaque-upstream-token",
    "sk-upstream-secret",
    "another-secret",
    "aGVsbG8=",
    "hidden-",
    "private-prompt",
  ])
    expect(message).not.toContain(value);
});

it.each([
  "<html>Unrelated gateway page</html>",
  '{"error":',
  JSON.stringify({ error: { message: "x".repeat(65 * 1024) } }),
  JSON.stringify({ error: { message: {}, code: 9, moderation_details: { categories: [null] } } }),
])("falls back to the confirmed HTTP status for unusable error bodies", async (body) => {
  await expect(
    client(async () => new Response(body, { status: 400 })).generate(
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    uncertain: false,
    message: "Image service returned HTTP 400. No automatic retry was sent.",
  });
});

it("bounds diagnostics when an error body stalls and cancels its reader", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  let reading!: () => void;
  const started = new Promise<void>((resolve) => (reading = resolve));
  const response = new Response(new ReadableStream({ pull: () => reading(), cancel }), {
    status: 502,
  });
  const pending = client(async () => response)
    .generate(input, new AbortController().signal)
    .catch((error: unknown) => error);
  await started;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await pending).toMatchObject({
    uncertain: true,
    message: "Image service returned HTTP 502. No automatic retry was sent.",
  });
  expect(cancel).toHaveBeenCalledOnce();
});

it("preserves Stop while reading a provider error body", async () => {
  const abort = new AbortController();
  const cancel = vi.fn();
  let reading!: () => void;
  const started = new Promise<void>((resolve) => (reading = resolve));
  const pending = client(
    async () =>
      new Response(new ReadableStream({ pull: () => reading(), cancel }), { status: 400 }),
  )
    .generate(input, abort.signal)
    .catch((error: unknown) => error);
  await started;
  abort.abort(new Error("User stopped generation"));
  expect(await pending).toMatchObject({ message: "User stopped generation" });
  expect(cancel).toHaveBeenCalledOnce();
});
