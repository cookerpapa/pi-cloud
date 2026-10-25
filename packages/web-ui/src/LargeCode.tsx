import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Large code remains exact and selectable while only visible lines mount.
 * Full-source highlighting is deliberately avoided for this large-output view. */
export function LargeCode({ text }: { text: string }) {
  const container = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const list = useVirtualizer({
    count: lines.length,
    getScrollElement: () => container.current,
    estimateSize: () => 22,
    overscan: 8,
    useAnimationFrameWithResizeObserver: true,
  });
  return (
    <div className="product-large-code" ref={container} tabIndex={0}>
      <div style={{ height: list.getTotalSize(), position: "relative", minWidth: "100%" }}>
        {list.getVirtualItems().map((line) => (
          <div
            key={line.key}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: 22,
              transform: `translateY(${line.start}px)`,
              whiteSpace: "pre",
            }}
          >
            <code>{lines[line.index] || "\u200b"}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
