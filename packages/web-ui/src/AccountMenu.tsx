import { useEffect, useRef, useState } from "react";
import { useI18n, type UiLanguage } from "./i18n.tsx";

export function AccountMenu({
  label,
  onLogout,
  placement = "down",
}: {
  label: string;
  onLogout: () => void;
  placement?: "up" | "down";
}) {
  const { language, setLanguage, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
        setLanguageOpen(false);
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setLanguageOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const chooseLanguage = (value: UiLanguage): void => {
    setLanguage(value);
    setLanguageOpen(false);
    setOpen(false);
  };

  return (
    <div
      className={`product-account-menu ${placement}`}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setLanguageOpen(false);
        }
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="product-account-menu-trigger"
        onClick={() => {
          setOpen((current) => !current);
          setLanguageOpen(false);
        }}
        type="button"
      >
        <span className="product-account-avatar">{label.slice(0, 1).toUpperCase()}</span>
        <strong>{label}</strong>
        <span aria-hidden="true" className="product-account-menu-chevron">
          {open ? (placement === "up" ? "⌄" : "⌃") : placement === "up" ? "⌃" : "⌄"}
        </span>
      </button>
      <div className="product-account-menu-panel" hidden={!open} role="menu">
        <div className="product-account-menu-language">
          <button
            aria-expanded={languageOpen}
            aria-haspopup="menu"
            onClick={() => setLanguageOpen((current) => !current)}
            role="menuitem"
            type="button"
          >
            <span>{t("language.label")}</span>
            <span aria-hidden="true">›</span>
          </button>
          <div className="product-account-language-submenu" hidden={!languageOpen} role="menu">
            {(
              [
                ["zh-CN", t("language.zh")],
                ["en-US", t("language.en")],
              ] as const
            ).map(([value, text]) => (
              <button
                aria-checked={language === value}
                key={value}
                onClick={() => chooseLanguage(value)}
                role="menuitemradio"
                type="button"
              >
                <span>{text}</span>
                <span aria-hidden="true">{language === value ? "✓" : ""}</span>
              </button>
            ))}
          </div>
        </div>
        <button
          className="product-account-menu-logout"
          onClick={() => {
            setOpen(false);
            onLogout();
          }}
          role="menuitem"
          type="button"
        >
          <span>{t("chat.logout")}</span>
          <span aria-hidden="true">↪</span>
        </button>
      </div>
    </div>
  );
}
