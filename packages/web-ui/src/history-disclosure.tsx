import { createContext, useContext, useState } from "react";

export const HistoryDisclosureContext = createContext<{
  values: Readonly<Record<string, boolean>>;
  toolGroupsExpanded?: boolean;
  set(keys: readonly string[], value: boolean): void;
} | null>(null);
export const ToolDisclosureContext = createContext("");
/** UI state belongs to the bounded reader, not to a virtual row's mount lifetime. */
export function useHistoryDisclosure(
  keys: readonly string[],
  defaultOpen = false,
): [boolean, (value: boolean) => void] {
  const context = useContext(HistoryDisclosureContext),
    [local, setLocal] = useState(defaultOpen);
  const selected = context
    ? keys.map((key) => context.values[key]).filter((value) => value !== undefined)
    : [];
  return context
    ? [selected.length ? selected.some(Boolean) : defaultOpen, (value) => context.set(keys, value)]
    : [local, setLocal];
}
