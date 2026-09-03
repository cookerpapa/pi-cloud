import { describe, expect, it } from "vitest";
import { ResponsesHostedActivityObserver } from "../src/index.ts";

describe("ResponsesHostedActivityObserver", () => {
  it("recognizes split SSE search lifecycle events and emits the Codex-style action", () => {
    const activities: unknown[] = [];
    const observer = new ResponsesHostedActivityObserver((activity) => activities.push(activity));
    const body = [
      'data: {"type":"response.output_item.added","item":{"id":"ws-1","type":"web_search_call"}}\n\n',
      'data: {"type":"response.web_search_call.searching","item_id":"ws-1"}\n\n',
      'data: {"type":"response.output_item.done","item":{"id":"ws-1","type":"web_search_call","status":"completed","action":{"type":"search","query":"private query"}}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
    ].join("");
    const encoded = new TextEncoder().encode(body);
    observer.push(encoded.subarray(0, 31));
    observer.push(encoded.subarray(31, 113));
    observer.push(encoded.subarray(113));
    observer.finish("completed");

    expect(activities).toEqual([
      { phase: "started", toolName: "web_search", activityId: "ws-1" },
      {
        phase: "completed",
        toolName: "web_search",
        activityId: "ws-1",
        outcome: "completed",
        action: { type: "search", queries: ["private query"] },
      },
    ]);
  });

  it("settles an active search when the Provider stream fails", () => {
    const activities: unknown[] = [];
    const observer = new ResponsesHostedActivityObserver((activity) => activities.push(activity));
    observer.push(
      new TextEncoder().encode(
        'data: {"type":"response.web_search_call.in_progress","item_id":"ws-failed"}\n\n',
      ),
    );
    observer.finish("failed");
    expect(activities).toEqual([
      { phase: "started", toolName: "web_search", activityId: "ws-failed" },
      {
        phase: "completed",
        toolName: "web_search",
        activityId: "ws-failed",
        outcome: "failed",
      },
    ]);
  });

  it("tracks concurrent DeepSeek search calls separately and removes transport markers", () => {
    const activities: unknown[] = [];
    const observer = new ResponsesHostedActivityObserver((activity) => activities.push(activity));
    const events = [
      {
        type: "response.output_item.added",
        item: { id: "call_00", type: "web_search_call", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        item: { id: "call_01", type: "web_search_call", status: "in_progress" },
      },
      {
        type: "response.output_item.done",
        item: {
          id: "call_00",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            queries: ["official Node release", "ws_call_id=call_00"],
          },
        },
      },
      {
        type: "response.output_item.done",
        item: {
          id: "call_01",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://python.org/downloads/#ws_call_id=call_01",
          },
        },
      },
    ];
    observer.push(
      new TextEncoder().encode(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      ),
    );
    observer.finish("completed");

    expect(activities).toEqual([
      { phase: "started", toolName: "web_search", activityId: "call_00" },
      { phase: "started", toolName: "web_search", activityId: "call_01" },
      {
        phase: "completed",
        toolName: "web_search",
        activityId: "call_00",
        outcome: "completed",
        action: { type: "search", queries: ["official Node release"] },
      },
      {
        phase: "completed",
        toolName: "web_search",
        activityId: "call_01",
        outcome: "completed",
        action: { type: "open_page", url: "https://python.org/downloads/" },
      },
    ]);
  });

  it("captures completed native search items and citations separately from progress", () => {
    const activities: unknown[] = [];
    const transcripts: unknown[] = [];
    const observer = new ResponsesHostedActivityObserver(
      (activity) => activities.push(activity),
      (items) => transcripts.push(items),
    );
    observer.push(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            output: [
              {
                type: "web_search_call",
                id: "ws-1",
                status: "completed",
                action: { type: "search", query: "current source" },
              },
              {
                type: "message",
                id: "msg-1",
                content: [
                  {
                    type: "output_text",
                    text: "answer",
                    annotations: [
                      {
                        type: "url_citation",
                        url: "https://example.test",
                        title: "Example",
                        start_index: 0,
                        end_index: 6,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        })}\n\n`,
      ),
    );
    observer.finish("completed");

    expect(transcripts).toEqual([
      [
        {
          outputIndex: 0,
          type: "web_search_call",
          id: "ws-1",
          nativeItem: {
            type: "web_search_call",
            id: "ws-1",
            status: "completed",
            action: { type: "search", query: "current source" },
          },
        },
        {
          outputIndex: 1,
          type: "message",
          id: "msg-1",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.test",
              title: "Example",
              start_index: 0,
              end_index: 6,
            },
          ],
        },
      ],
    ]);
  });
});
