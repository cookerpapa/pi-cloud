import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { defaultRangeExtractor, type Range } from "@tanstack/react-virtual";

type Pin = { anchor: string; focus: string; dragging: boolean };
/** Keep native Selection endpoints and the selected band mounted. The keys are
 * only those in the existing bounded reader; selection never loads history. */
export function useVirtualSelection(
  container: RefObject<HTMLElement | null>,
  keys: readonly string[],
  onRead?: () => void,
) {
  const [pin, setPin] = useState<Pin | null>(null);
  const current = useRef(pin),
    pointer = useRef(false),
    callback = useRef(onRead);
  const keySet = useMemo(() => new Set(keys), [keys]),
    available = useRef(keySet);
  available.current = keySet;
  callback.current = onRead;
  const update = useCallback((next: Pin | null) => {
    const old = current.current;
    if (
      old?.anchor === next?.anchor &&
      old?.focus === next?.focus &&
      old?.dragging === next?.dragging
    )
      return;
    current.current = next;
    setPin(next);
  }, []);
  const clear = useCallback(() => {
    pointer.current = false;
    const selected = window.getSelection();
    if (
      selected &&
      (container.current?.contains(selected.anchorNode) ||
        container.current?.contains(selected.focusNode))
    )
      selected.removeAllRanges();
    update(null);
  }, [container, update]);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const keyFor = (node: Node | null): string | undefined => {
      let element = node instanceof Element ? node : node?.parentElement;
      while (element && root.contains(element)) {
        const key = element.getAttribute("data-virtual-selection-key");
        if (key && available.current.has(key)) return key;
        element = element.parentElement;
      }
      return undefined;
    };
    const selected = () => {
      const selection = window.getSelection();
      const anchor = keyFor(selection?.anchorNode ?? null),
        focus = keyFor(selection?.focusNode ?? null);
      if (selection && !selection.isCollapsed && (anchor || focus)) {
        if (!current.current) callback.current?.();
        update({ anchor: anchor ?? focus!, focus: focus ?? anchor!, dragging: pointer.current });
      } else if (!pointer.current) update(null);
    };
    const down = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        !(event.target instanceof Element) ||
        event.target.closest("button,a,input,textarea,select,summary,[contenteditable=true]")
      )
        return;
      const key = keyFor(event.target);
      if (!key) return;
      pointer.current = true;
      update({ anchor: key, focus: key, dragging: true });
      callback.current?.();
    };
    const up = () => {
      pointer.current = false;
      selected();
    };
    root.addEventListener("pointerdown", down, true);
    document.addEventListener("selectionchange", selected);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    return () => {
      root.removeEventListener("pointerdown", down, true);
      document.removeEventListener("selectionchange", selected);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
    };
  }, [container, update]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const normal = defaultRangeExtractor(range);
      if (!pin) return normal;
      const anchor = keys.indexOf(pin.anchor),
        focus = keys.indexOf(pin.focus);
      if (anchor < 0 || focus < 0) return normal;
      const first = Math.min(anchor, focus, pin.dragging ? range.startIndex : anchor);
      const last = Math.max(anchor, focus, pin.dragging ? range.endIndex : anchor);
      const indexes = new Set(normal);
      for (let i = first; i <= last; i++) indexes.add(i);
      return [...indexes].sort((a, b) => a - b);
    },
    [pin, keys],
  );
  return { active: pin !== null, isActive: () => current.current !== null, rangeExtractor, clear };
}
