import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAXIMUM_REQUEST_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_RESPONSE_BYTES = 16 * 1_024 * 1_024;
const ENVD_PORT = 49_983;

type PreviewRequest = Readonly<{
  port: number;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  path: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  maximumResponseBytes: number;
  timeoutMs: number;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} was invalid`);
  }
  return value as Record<string, unknown>;
}

async function input(): Promise<Record<string, unknown>> {
  const path = process.argv[2];
  if (path === undefined || !/^\/tmp\/pi-cloud-envd-[0-9a-f-]{36}\.json$/u.test(path)) {
    throw new Error("Preview input path was invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 6 * 1_024 * 1_024) {
      throw new Error("Preview input was invalid");
    }
    return record(JSON.parse((await handle.readFile()).toString("utf8")), "Preview input");
  } finally {
    await handle.close();
  }
}

function request(value: unknown): PreviewRequest {
  const raw = record(value, "Preview request");
  const keys = Object.keys(raw).sort().join(",");
  if (
    keys !== "headers,maximumResponseBytes,method,path,port,timeoutMs" &&
    keys !== "body,headers,maximumResponseBytes,method,path,port,timeoutMs"
  ) {
    throw new Error("Preview request shape was invalid");
  }
  if (
    !Number.isSafeInteger(raw.port) ||
    (raw.port as number) < 1_024 ||
    (raw.port as number) > 65_535 ||
    raw.port === ENVD_PORT
  ) {
    throw new Error("Preview port was invalid");
  }
  if (
    typeof raw.method !== "string" ||
    !new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).has(raw.method)
  ) {
    throw new Error("Preview method was invalid");
  }
  if (
    typeof raw.path !== "string" ||
    raw.path.length > 8_192 ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/u.test(raw.path)
  ) {
    throw new Error("Preview path was invalid");
  }
  const rawHeaders = record(raw.headers, "Preview headers");
  if (Object.keys(rawHeaders).length > 32) throw new Error("Preview headers were invalid");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase();
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(lower) ||
      new Set(["host", "authorization", "cookie", "connection", "content-length"]).has(lower) ||
      typeof value !== "string" ||
      value.length > 8_192 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("Preview header was invalid");
    }
    headers[lower] = value;
  }
  if (
    !Number.isSafeInteger(raw.maximumResponseBytes) ||
    (raw.maximumResponseBytes as number) < 1 ||
    (raw.maximumResponseBytes as number) > MAXIMUM_RESPONSE_BYTES ||
    !Number.isSafeInteger(raw.timeoutMs) ||
    (raw.timeoutMs as number) < 100 ||
    (raw.timeoutMs as number) > 60_000
  ) {
    throw new Error("Preview limits were invalid");
  }
  let body: string | undefined;
  if (raw.body !== undefined) {
    if (
      typeof raw.body !== "string" ||
      raw.body.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw.body)
    ) {
      throw new Error("Preview body was invalid");
    }
    const bytes = Buffer.from(raw.body, "base64");
    if (bytes.byteLength > MAXIMUM_REQUEST_BYTES) throw new Error("Preview body was too large");
    body = raw.body;
  }
  return {
    port: raw.port as number,
    method: raw.method as PreviewRequest["method"],
    path: raw.path,
    headers,
    ...(body === undefined ? {} : { body }),
    maximumResponseBytes: raw.maximumResponseBytes as number,
    timeoutMs: raw.timeoutMs as number,
  };
}

async function boundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) throw new Error("Preview response was too large");
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function proxy(preview: PreviewRequest): Promise<Record<string, unknown>> {
  const response = await fetch(`http://localhost:${String(preview.port)}${preview.path}`, {
    method: preview.method,
    headers: preview.headers,
    ...(preview.body === undefined ? {} : { body: Buffer.from(preview.body, "base64") }),
    redirect: "manual",
    signal: AbortSignal.timeout(preview.timeoutMs),
  });
  const body = await boundedBody(response, preview.maximumResponseBytes);
  const allowedResponseHeaders = new Set([
    "accept-ranges",
    "cache-control",
    "content-encoding",
    "content-language",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
    "location",
  ]);
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers.entries()) {
    const lower = name.toLowerCase();
    if (allowedResponseHeaders.has(lower) && value.length <= 8_192) headers[lower] = value;
  }
  return { status: response.status, headers, body: body.toString("base64") };
}

const raw = await input();
if (raw.mode !== "preview_http" || Object.keys(raw).sort().join(",") !== "mode,request") {
  throw new Error("Preview operation was invalid");
}
process.stdout.write(`${JSON.stringify(await proxy(request(raw.request)))}\n`);
