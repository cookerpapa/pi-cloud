import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ChatApp from "./ChatApp.tsx";
import { I18nProvider } from "./i18n.tsx";
import "./product.css";
import { loadWebConfiguration } from "./web-configuration.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("Pi Managed Agents root element is missing");

const renderer = createRoot(root);
void loadWebConfiguration().then(
  (configuration) =>
    renderer.render(
      <StrictMode>
        <I18nProvider>
          <ChatApp configuration={configuration} />
        </I18nProvider>
      </StrictMode>,
    ),
  (error: unknown) => {
    console.error("Pi Managed Agents Web configuration could not be loaded", error);
    renderer.render(
      <main role="alert">
        Pi Managed Agents Web configuration is unavailable. Reload after checking the deployment
        configuration.
      </main>,
    );
  },
);
