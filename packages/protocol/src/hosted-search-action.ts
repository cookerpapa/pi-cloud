import type { ProviderHostedWebSearchAction } from "./index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, maximumLength);
}

function publicSearchUrl(value: unknown): string | undefined {
  const url = boundedText(value, 16_384);
  return url?.replace(/#ws_call_id=[A-Za-z0-9._-]+$/u, "");
}

export function normalizeProviderHostedWebSearchAction(
  value: unknown,
): ProviderHostedWebSearchAction | undefined {
  const action = isRecord(value) && isRecord(value.action) ? value.action : value;
  if (!isRecord(action)) return undefined;
  if (action.type === "open_page") {
    const url = publicSearchUrl(action.url);
    return url === undefined ? undefined : { type: "open_page", url };
  }
  if (action.type === "find_in_page") {
    const url = publicSearchUrl(action.url);
    const pattern = boundedText(action.pattern, 4_096);
    return url === undefined && pattern === undefined
      ? undefined
      : {
          type: "find_in_page",
          ...(url === undefined ? {} : { url }),
          ...(pattern === undefined ? {} : { pattern }),
        };
  }
  if (action.type !== "search" && action.query === undefined && action.queries === undefined) {
    return undefined;
  }
  const candidates = [
    ...(Array.isArray(action.queries) ? action.queries : []),
    ...(action.query === undefined ? [] : [action.query]),
  ];
  const queries = [
    ...new Set(
      candidates
        .map((query) => boundedText(query, 4_096))
        .filter((query): query is string => query !== undefined && !/^ws_call_id=/u.test(query)),
    ),
  ].slice(0, 16);
  return queries.length === 0 ? undefined : { type: "search", queries };
}
