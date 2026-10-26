import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTurn } from "../src/ConversationTurn.tsx";
import {
  createInitialSessionView,
  sessionViewReducer,
  type TurnView,
} from "../src/session-view.ts";
import type { PiCloudEvent } from "@pi-cloud/protocol";
const origin = {
  kind: "schedule" as const,
  scheduleId: "10000000-0000-4000-8000-000000000002",
  revision: "1",
  name: "Morning summary",
  scheduledAt: "2026-10-26T00:00:00.000Z",
  timezone: "Asia/Shanghai",
};
const turn: TurnView = {
  runId: "run",
  turnId: "turn",
  scheduledOrigin: origin,
  mailboxPosition: 1,
  prompt: "Report status",
  acceptedAt: "2026-10-26T00:00:00.000Z",
  status: "completed",
  items: [],
  startedSequence: 1,
  terminalSequence: 2,
  stopReason: "stop",
  failure: null,
  cancellation: null,
};
it("labels the scheduled input without duplicating the label on later virtual fragments", () => {
  const text = renderToStaticMarkup(<ConversationTurn turn={turn} />);
  expect(text).toContain('data-scheduled-origin="' + origin.scheduleId + '"');
  expect(text).toContain("Morning summary");
  expect(text).toContain("Report status");
  expect(
    renderToStaticMarkup(
      <ConversationTurn turn={turn} fragment={{ header: false, footer: true, rows: [] }} />,
    ),
  ).not.toContain("data-scheduled-origin");
});
it("receives the same scheduled origin on the live Run-start path", () => {
  const state = createInitialSessionView();
  const loaded = {
    ...state,
    session: { sessionId: "session" } as NonNullable<typeof state.session>,
  };
  const event = {
    type: "turn.started",
    sessionId: "session",
    turnId: "turn",
    seq: 1,
    payload: { inputKind: "prompt", scheduledOrigin: origin },
  } as PiCloudEvent;
  const view = sessionViewReducer(loaded, { type: "stream.event", event });
  expect(view.turns[0]?.scheduledOrigin).toEqual(origin);
});
