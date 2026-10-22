import { fileURLToPath } from "node:url";

// Cube's envd may construct a fresh command environment. Bind this explicitly
// selected platform package to its own baked browser revisions before import.
process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL("./browsers", import.meta.url));
export const { chromium, devices } = await import("playwright");
