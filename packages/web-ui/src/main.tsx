import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ChatApp from "./ChatApp.tsx";
import { I18nProvider } from "./i18n.tsx";
import "./product.css";

const root = document.getElementById("root");
if (root === null) throw new Error("PiCloud root element is missing");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <ChatApp />
    </I18nProvider>
  </StrictMode>,
);
