import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

function storedNumber(key: string, fallback: number): number {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (stored == null || stored.trim() === "") return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storedBoolean(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function useResizablePanel(options: {
  storageKey: string;
  initialWidth: number;
  minimumWidth: number;
  maximumWidth: number;
}) {
  const { storageKey, initialWidth, minimumWidth, maximumWidth } = options;
  const clamp = useCallback(
    (value: number) => Math.min(maximumWidth, Math.max(minimumWidth, Math.round(value))),
    [maximumWidth, minimumWidth],
  );
  const [width, setWidthState] = useState(() =>
    clamp(storedNumber(`${storageKey}:width`, initialWidth)),
  );
  const [collapsed, setCollapsed] = useState(() => storedBoolean(`${storageKey}:collapsed`));
  const stopResize = useRef<(() => void) | undefined>(undefined);

  const setWidth = useCallback(
    (value: number) => {
      const next = clamp(value);
      setWidthState(next);
      try {
        globalThis.localStorage?.setItem(`${storageKey}:width`, String(next));
      } catch {
        /* Local persistence is an optional convenience. */
      }
    },
    [clamp, storageKey],
  );

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        globalThis.localStorage?.setItem(`${storageKey}:collapsed`, String(next));
      } catch {
        /* Local persistence is an optional convenience. */
      }
      return next;
    });
  }, [storageKey]);

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      stopResize.current?.();
      const startX = event.clientX;
      const startWidth = width;
      const move = (pointerEvent: PointerEvent): void => {
        setWidth(startWidth + pointerEvent.clientX - startX);
      };
      const finish = (): void => {
        globalThis.removeEventListener("pointermove", move);
        globalThis.removeEventListener("pointerup", finish);
        globalThis.removeEventListener("pointercancel", finish);
        globalThis.removeEventListener("blur", finish);
        document.body.classList.remove("product-panel-resizing");
        stopResize.current = undefined;
      };
      document.body.classList.add("product-panel-resizing");
      globalThis.addEventListener("pointermove", move);
      globalThis.addEventListener("pointerup", finish, { once: true });
      globalThis.addEventListener("pointercancel", finish, { once: true });
      globalThis.addEventListener("blur", finish, { once: true });
      stopResize.current = finish;
    },
    [collapsed, setWidth, width],
  );

  useEffect(
    () => () => {
      stopResize.current?.();
    },
    [],
  );

  return { width, collapsed, setWidth, toggle, beginResize };
}
