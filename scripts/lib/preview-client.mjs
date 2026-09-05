import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Acceptance uses loopback transport while retaining the real Preview Host/SNI.
export async function readPreviewDocument(bootstrapUrl, connectHost) {
  let url = new URL(bootstrapUrl);
  const origin = url.origin;
  let cookie = "";
  for (let hop = 0; hop < 5; hop++) {
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        {
          hostname: connectHost,
          servername: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          headers: { host: url.host, accept: "*/*", ...(cookie ? { cookie } : {}) },
        },
        (incoming) => {
          const bytes = [];
          incoming.on("data", (chunk) => bytes.push(chunk));
          incoming.once("end", () =>
            resolve({
              status: incoming.statusCode,
              headers: incoming.headers,
              body: Buffer.concat(bytes),
            }),
          );
          incoming.once("error", reject);
        },
      );
      request.once("error", reject);
      request.setTimeout(30_000, () =>
        request.destroy(new Error("Preview acceptance request timed out")),
      );
      request.end();
    });
    const cookies = response.headers["set-cookie"];
    if (cookies) cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const next = new URL(response.headers.location, url);
      if (next.origin !== origin)
        throw new Error("Preview acceptance refuses cross-origin credential forwarding");
      url = next;
      continue;
    }
    return { ...response, url: url.toString() };
  }
  throw new Error("Preview redirect limit exceeded");
}
