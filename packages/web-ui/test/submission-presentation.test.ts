import { expect, it } from "vitest";
import {
  composerPlacement,
  authoritativeInputAppeared,
  withLocalSubmission,
} from "../src/submission-presentation.ts";
import { createInitialSessionView, type TurnView } from "../src/session-view.ts";
import type { ComposerSubmissionView } from "../src/composer-submission.ts";
import { virtualConversationRows } from "../src/virtual-conversation-rows.ts";
const old: TurnView = {
  turnId: "old",
  runId: "old-run",
  mailboxPosition: 7,
  prompt: "same text",
  acceptedAt: null,
  status: "completed",
  items: [],
  startedSequence: 20,
  terminalSequence: 30,
  stopReason: "stop",
  failure: null,
  cancellation: null,
};
const view: ComposerSubmissionView = {
  input: { kind: "turn", sessionId: "session", text: "same text", uploadIds: [] },
  state: "sending",
  key: "local-key",
  ...composerPlacement({ ...createInitialSessionView(), turns: [old] }, null, false),
};
it("renders idle input immediately without inserting a backend Turn or a fake run status", () => {
  const original = [old];
  const presented = withLocalSubmission(original, view);
  expect(original).toEqual([old]);
  expect(presented).toHaveLength(2);
  const rows = virtualConversationRows(presented).filter((row) => row.turn.localSubmission);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    key: "local-key:header",
    fragment: { header: true, footer: false },
    turn: { runId: null },
  });
  expect(withLocalSubmission(original, { ...view, placement: "queue" })).toBe(original);
});
it("keeps provisional input separate when SSE starts a Run before its receipt", () => {
  const unknown: TurnView = {
    ...old,
    turnId: "new",
    runId: null,
    prompt: null,
    status: "running",
    mailboxPosition: null,
    startedSequence: 31,
    terminalSequence: null,
  };
  const rendered = withLocalSubmission([old, unknown], view);
  expect(rendered.map((turn) => turn.turnId)).toEqual(["old", "local:local-key", "new"]);
  expect(rendered[2]?.prompt).toBeNull();
});
it("uses receipt identity to keep the header stable and shows accepted queued Runs in the transcript", () => {
  const accepted = {
    ...old,
    turnId: "actual",
    status: "queued" as const,
    mailboxPosition: 8,
    presentationKey: view.key,
  };
  const turns = [old, accepted];
  expect(withLocalSubmission(turns, view)).toBe(turns);
  const header = virtualConversationRows(turns).find(
    (row) => row.turn === accepted && row.fragment.header,
  );
  expect(header?.key).toBe("local-key:header");
});
it("only suppresses uncertain text on authoritative discovery, never matches old text", () => {
  expect(authoritativeInputAppeared(view, [old])).toBe(false);
  expect(
    authoritativeInputAppeared(view, [old, { ...old, turnId: "another-tab", mailboxPosition: 8 }]),
  ).toBe(true);
  expect(view.state).toBe("sending");
});
it("keeps image-only and failed sends visible for retry without fabricating server attachments", () => {
  const result = withLocalSubmission([old], {
    ...view,
    state: "unconfirmed",
    input: { ...view.input, text: "", uploadIds: ["image"] },
  });
  expect(result[1]).toMatchObject({
    prompt: "",
    localSubmission: { state: "unconfirmed", input: { uploadIds: ["image"] } },
  });
  expect(result[1]?.uploads).toBeUndefined();
  expect(
    virtualConversationRows(result).some((row) => row.turn === result[1] && row.fragment.header),
  ).toBe(true);
});
