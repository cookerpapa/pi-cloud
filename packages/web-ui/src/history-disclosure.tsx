import { createContext, useContext, useState } from "react";

export const HistoryDisclosureContext = createContext<{
  values: Readonly<Record<string, boolean>>;
  allToolsExpanded?: boolean;
  set(keys: readonly string[], value: boolean): void;
} | null>(null);
export const ToolDisclosureContext = createContext("");
/** UI state belongs to the bounded reader, not to a virtual row's mount lifetime. */
export function useHistoryDisclosure(keys: readonly string[]): [boolean, (value: boolean) => void] {
  const context = useContext(HistoryDisclosureContext),
    [local, setLocal] = useState(false);
  return context
    ? [
        keys.some((key) => context.values[key] ?? context.allToolsExpanded ?? false),
        (value) => context.set(keys, value),
      ]
    : [local, setLocal];
}
