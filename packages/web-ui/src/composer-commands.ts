export type ComposerCommand =
  | { kind: "usage" }
  | { kind: "compact"; instructions: string }
  | { kind: "invalid"; reason: "usage_arguments" };
export function parseComposerCommand(text: string): ComposerCommand | undefined {
  const match = /^\/(usage|compact)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const rest = (match[2] ?? "").trim();
  return match[1] === "compact"
    ? { kind: "compact", instructions: rest }
    : rest
      ? { kind: "invalid", reason: "usage_arguments" }
      : { kind: "usage" };
}
export function composerCommandSuggestions(text: string): Array<"usage" | "compact"> {
  const value = text.trimStart();
  if (!/^\/[a-z]*$/.test(value)) return [];
  return (["usage", "compact"] as const).filter((command) => command.startsWith(value.slice(1)));
}
export const compactionPending = (state: string) =>
  ["queued", "summarizing", "awaiting_placement"].includes(state);
