import { useI18n } from "./i18n.tsx";
import { useEffect, useId, useRef, type ReactNode } from "react";
export function SkillDialog({
  title,
  busy = false,
  onClose,
  children,
}: {
  title: string;
  busy?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const { language } = useI18n();
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.querySelector<HTMLInputElement>('.skill-market input[type="search"]')?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="skill-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="skill-dialog-header">
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          className="skill-close"
          aria-label={language === "zh-CN" ? "关闭" : "Close"}
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
