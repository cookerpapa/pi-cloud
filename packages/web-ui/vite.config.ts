import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiOrigin = process.env.PI_CLOUD_DEMO_API_ORIGIN ?? "http://127.0.0.1:3100";
const webPort = Number(process.env.PI_CLOUD_DEMO_WEB_PORT ?? "4173");
if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) {
  throw new Error("PI_CLOUD_DEMO_WEB_PORT must be an integer between 1 and 65535");
}
const apiProxy = {
  "/v1": {
    target: apiOrigin,
    changeOrigin: false,
  },
};
const configure = (server: import("vite").ViteDevServer | import("vite").PreviewServer) => {
  server.middlewares.use("/ui-config.json", (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const origin = `http://${request.headers.host}`;
    response.end(
      JSON.stringify({
        productUrl: origin,
        adminUrl: origin,
        managementUrls: {
          providerGateway: "",
          grafana: "",
          prometheus: "",
          alertmanager: "",
          jaeger: "",
        },
      }),
    );
  });
};

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-web-configuration",
      configureServer: configure,
      configurePreviewServer: configure,
    },
  ],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
