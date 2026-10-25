import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { UuidSchema } from "./protocol-primitives.ts";

/** Read/cache budgets, not conversation-length or execution quotas. */
export const HISTORY_PAGE_RECORDS = 64;
// Includes a native record, its Tool intent and bounded human presentation
// metadata. Input admission already bounds the three native startup copies.
export const HISTORY_PAGE_BYTES = 4 * 1024 * 1024;
export const HISTORY_BROWSER_PAGES = 4;
export const HISTORY_LIVE_ITEMS = 256;
export const HISTORY_LIVE_CHARACTERS = 2 * 1024 * 1024;
export const HistoryCursorSchema = Type.String({ minLength: 1, maxLength: 2048 });
export const ConversationHistoryBoundarySchema = Type.Object(
  {
    before: Type.Union([HistoryCursorSchema, Type.Null()]),
    after: Type.Union([HistoryCursorSchema, Type.Null()]),
    hasBefore: Type.Boolean(),
    hasAfter: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ConversationHistoryBoundary = Static<typeof ConversationHistoryBoundarySchema>;
export const emptyConversationHistory = (): ConversationHistoryBoundary => ({
  before: null,
  after: null,
  hasBefore: false,
  hasAfter: false,
});

export const ConversationHistoryQuerySchema = Type.Object(
  {
    before: Type.Optional(HistoryCursorSchema),
    after: Type.Optional(HistoryCursorSchema),
    at: Type.Optional(HistoryCursorSchema),
    turnId: Type.Optional(UuidSchema),
    direction: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])),
    toolCallId: Type.Optional(Type.String({ pattern: "^(task|entry):[1-9][0-9]{0,15}$" })),
    entryId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,15}$" })),
  },
  { additionalProperties: false },
);
export type ConversationHistoryQuery = Static<typeof ConversationHistoryQuerySchema>;
export function parseConversationHistoryQuery(value: unknown): ConversationHistoryQuery {
  if (
    !Value.Check(ConversationHistoryQuerySchema, value) ||
    Number(value.before !== undefined) +
      Number(value.after !== undefined) +
      Number(value.at !== undefined) +
      Number(value.turnId !== undefined) >
      1 ||
    (value.entryId !== undefined && value.toolCallId !== undefined) ||
    ((value.entryId !== undefined ||
      value.toolCallId !== undefined ||
      value.direction !== undefined) &&
      value.turnId === undefined)
  )
    throw new TypeError("Invalid conversation history position");
  return value;
}

export const ConversationSearchResultSchema = Type.Object(
  {
    sessionId: UuidSchema,
    results: Type.Array(
      Type.Object(
        {
          turnId: UuidSchema,
          cursor: HistoryCursorSchema,
          kind: Type.String(),
          snippet: Type.String({ maxLength: 1000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: HISTORY_PAGE_RECORDS },
    ),
    nextCursor: Type.Union([HistoryCursorSchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ConversationSearchResult = Static<typeof ConversationSearchResultSchema>;
export function parseConversationSearchResult(value: unknown): ConversationSearchResult {
  if (!Value.Check(ConversationSearchResultSchema, value))
    throw new TypeError("Invalid conversation search result");
  return value;
}
