import { describe, expect, it } from "vitest";
import { ResponsesHostedActivityObserver } from "../src/index.ts";

describe("ResponsesHostedActivityObserver", () => {
  it("recognizes split SSE search lifecycle events and emits no Provider payload", () => {
    const activities: unknown[] = [];
    const observer = new ResponsesHostedActivityObserver((activity) => activities.push(activity));
    const body = [
      'data: {"type":"response.output_item.added","item":{"type":"web_search_call"}}\n\n',
      'data: {"type":"response.web_search_call.searching"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"web_search_call","status":"completed","action":{"query":"private query"}}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
    ].join("");
    const encoded = new TextEncoder().encode(body);
    observer.push(encoded.subarray(0, 31));
    observer.push(encoded.subarray(31, 113));
    observer.push(encoded.subarray(113));
    observer.finish("completed");

    expect(activities).toEqual([
      { phase: "started", toolName: "web_search" },
      { phase: "completed", toolName: "web_search", outcome: "completed" },
    ]);
    expect(JSON.stringify(activities)).not.toContain("private query");
  });

  it("settles an active search when the Provider stream fails", () => {
    const activities: unknown[] = [];
    const observer = new ResponsesHostedActivityObserver((activity) => activities.push(activity));
    observer.push(
      new TextEncoder().encode('data: {"type":"response.web_search_call.in_progress"}\n\n'),
    );
    observer.finish("failed");
    expect(activities).toEqual([
      { phase: "started", toolName: "web_search" },
      { phase: "completed", toolName: "web_search", outcome: "failed" },
    ]);
  });
});
