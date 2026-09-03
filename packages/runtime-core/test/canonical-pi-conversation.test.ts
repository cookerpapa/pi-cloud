import type { Database } from "@pi-cloud/database";
import { readCanonicalPiTurnTranscripts } from "../src/canonical-pi-conversation.ts";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const TURN_ID = "10000000-0000-4000-8000-000000000002";

function database(): Kysely<Database> {
  const rows: Record<string, unknown[]> = {
    pi_session_entries: [
      {
        turn_id: TURN_ID,
        seq: "2",
        timestamp_ms: "1787529600000",
        payload: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Before maintenance." }],
          },
        },
      },
      {
        turn_id: TURN_ID,
        seq: "3",
        timestamp_ms: "1787529600050",
        payload: {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "providerHostedToolCall",
                toolName: "web_search",
                nativeItem: {
                  id: "call_search_1",
                  type: "web_search_call",
                  status: "completed",
                  action: {
                    type: "search",
                    queries: ["official release", "ws_call_id=call_search_1"],
                  },
                },
              },
            ],
          },
        },
      },
      {
        turn_id: TURN_ID,
        seq: "4",
        timestamp_ms: "1787529600100",
        payload: {
          type: "compaction",
          summary: "Earlier work",
          retainedTail: [],
          tokensBefore: 80_000,
        },
      },
      {
        turn_id: TURN_ID,
        seq: "5",
        timestamp_ms: "1787529600150",
        payload: {
          type: "custom",
          customType: "pi-cloud.model_retry",
          data: {
            nextSamplingAttempt: 2,
            maximumSamplingAttempts: 3,
            delayMs: 1_500,
          },
        },
      },
      {
        turn_id: TURN_ID,
        seq: "6",
        timestamp_ms: "1787529600200",
        payload: {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "After maintenance." }],
          },
        },
      },
      {
        turn_id: TURN_ID,
        seq: "7",
        timestamp_ms: "1787529600250",
        payload: {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "preview-call",
                name: "preview",
                arguments: { port: 4_173 },
              },
            ],
          },
        },
      },
      {
        turn_id: TURN_ID,
        seq: "8",
        timestamp_ms: "1787529600300",
        payload: {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "preview-call",
            toolName: "preview",
            isError: false,
            content: [{ type: "text", text: "PiCloud published the service." }],
            details: {
              port: 4_173,
              previewPath: `/v1/conversations/${TURN_ID}/preview/4173/`,
            },
          },
        },
      },
    ],
    session_terminal_events: [
      {
        turn_id: TURN_ID,
        seq: "10",
        type: "turn.completed",
        payload: { stopReason: "stop" },
        occurred_at: new Date("2026-08-24T00:00:01.000Z"),
      },
    ],
  };
  return {
    selectFrom(table: string) {
      const query = {
        select() {
          return this;
        },
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        async execute() {
          return rows[table] ?? [];
        },
      };
      return query;
    },
  } as unknown as Kysely<Database>;
}

describe("canonical Pi conversation", () => {
  it("reconstructs completed compaction and retry attempts from native SessionStorage facts", async () => {
    const transcripts = await readCanonicalPiTurnTranscripts(database(), {
      tenantId: TENANT_ID,
      turnIds: [TURN_ID],
    });
    expect(transcripts.get(TURN_ID)?.items).toMatchObject([
      { kind: "text", text: "Before maintenance." },
      {
        kind: "hosted_search",
        activityId: "call_search_1",
        status: "completed",
        action: { type: "search", queries: ["official release"] },
      },
      {
        kind: "compaction",
        status: "completed",
        tokensBefore: 80_000,
      },
      {
        kind: "retry",
        nextSamplingAttempt: 2,
        maximumSamplingAttempts: 3,
        delayMs: 1_500,
      },
      { kind: "text", text: "After maintenance." },
      {
        kind: "tool",
        toolCallId: "preview-call",
        toolName: "preview",
        status: "completed",
        output: {
          content: [{ type: "text", text: "PiCloud published the service." }],
          details: {
            port: 4_173,
            previewPath: `/v1/conversations/${TURN_ID}/preview/4173/`,
          },
        },
      },
    ]);
  });
});
