import {
  ScheduleToolParametersSchema,
  parseScheduleToolInput,
  type SessionSchedule,
  type SessionScheduleSummary,
} from "@pi-cloud/protocol";
import type { RegisteredControlTool } from "../control-tool-registry.ts";
import { ControlPlaneStoreError } from "../control-plane-store-error.ts";
import type { SessionScheduleService } from "../session-schedule-service.ts";

const summary = (value: SessionSchedule | SessionScheduleSummary) => ({
  id: value.id,
  name: value.name,
  revision: value.revision,
  state: value.state,
  timing: value.timing,
  missed: value.missed,
  nextFireAt: value.nextFireAt,
  lastRun: value.lastRun,
  error: value.error,
  lastSkippedAt: value.lastSkippedAt,
});
export function createScheduleTool(service: SessionScheduleService): RegisteredControlTool {
  return {
    definition: {
      name: "schedule",
      environment: { kind: "none" },
      availability: "root",
      description:
        "Manage time-triggered tasks for this root conversation. create requires name, prompt (the instruction for each future turn), and timing: {kind:'once',at:ISO timestamp with offset} or {kind:'after',seconds:positive integer} or {kind:'cron',expression:five-field cron,timezone:IANA zone}. Use after for relative requests; the server computes its fixed deadline from PG time. Use Asia/Shanghai unless the user specifies another timezone. Default missed=latest admits the most recent overdue occurrence; missed=skip suppresses occurrences over 60 seconds late. list accepts a cursor and returns serverTime for date-relative planning; get requires id and returns a bounded prompt page (continue with nextPromptOffset). update requires id, current revision and patch; pause/resume/delete require id and revision from list/get. Paused intervals are not replayed. Tasks use normal Run admission and wait for this conversation to be idle; they do not steer active work. The same plan does not overlap itself. Deletion stops future triggers; already admitted Runs remain independently stoppable. No Workspace or phone is allocated by this Tool. Use the user's language for the name and stored prompt.",
      parameters: JSON.parse(JSON.stringify(ScheduleToolParametersSchema)),
    },
    // A committed mutation with a lost reply is inspected, never automatically replayed.
    replay: "never",
    async execute(call, current) {
      if (!current()) throw Error("Control Tool owner changed");
      const scope = { tenantId: call.scope.tenantId, sessionId: call.scope.sessionId };
      try {
        const input = parseScheduleToolInput(call.arguments);
        let result: unknown;
        switch (input.action) {
          case "create": {
            const { action: _action, ...config } = input;
            result = summary(await service.create(scope, call.operationId, config));
            break;
          }
          case "list": {
            const value = await service.list(scope, input.cursor, 20);
            result = {
              schedules: value.schedules.map(summary),
              nextCursor: value.nextCursor,
              serverTime: await service.currentTime(),
              defaultTimezone: "Asia/Shanghai",
            };
            break;
          }
          case "get": {
            const value = await service.get(scope, input.id),
              offset = input.promptOffset ?? 0;
            if (
              offset > value.prompt.length ||
              (offset > 0 && /[\uDC00-\uDFFF]/.test(value.prompt[offset] ?? ""))
            )
              throw new ControlPlaneStoreError(
                "invalid_request",
                "Prompt offset must point to a valid text boundary",
              );
            let text = value.prompt.slice(offset, offset + 4096);
            if (/[\uD800-\uDBFF]/.test(text.at(-1) ?? "")) text = text.slice(0, -1);
            result = {
              ...summary(value),
              prompt: text,
              promptOffset: offset,
              nextPromptOffset:
                offset + text.length < value.prompt.length ? offset + text.length : null,
            };
            break;
          }
          case "update":
          case "pause":
          case "resume": {
            const { id, ...change } = input;
            result = summary(await service.change(scope, id, change));
            break;
          }
          case "delete":
            result = await service.delete(scope, input.id, input.revision);
            break;
        }
        return { result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
      } catch (error) {
        if (error instanceof ControlPlaneStoreError || error instanceof TypeError)
          return {
            isError: true,
            result: {
              content: [
                {
                  type: "text",
                  text: `schedule_${error instanceof ControlPlaneStoreError ? error.code : "invalid_request"}: ${error.message}`,
                },
              ],
            },
          };
        throw error;
      }
    },
  };
}
