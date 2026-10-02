// Measurement-only loader: resolve every workspace import from one chosen checkout.
// Shared third-party node_modules must never silently select current @pi-cloud source.
import { registerHooks } from "node:module";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = realpathSync(process.env.PI_CLOUD_REVIEW_SOURCE_ROOT);
const routed = new Map();
const packages = new Map();
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@pi-cloud/")) {
      const [scope, name, ...rest] = specifier.split("/");
      let manifest = packages.get(name);
      if (!manifest) {
        manifest = JSON.parse(
          readFileSync(resolve(root, "packages", name, "package.json"), "utf8"),
        );
        packages.set(name, manifest);
      }
      const subpath = rest.length ? "./" + rest.join("/") : ".";
      let target =
        typeof manifest.exports === "string" && subpath === "."
          ? manifest.exports
          : manifest.exports[subpath];
      if (typeof target !== "string") target = target?.import ?? target?.default;
      if (typeof target !== "string") throw new Error("Unresolved workspace source " + specifier);
      const absolute = realpathSync(resolve(root, "packages", name, target));
      if (!absolute.startsWith(root + "/packages/"))
        throw new Error("Workspace escaped source root");
      routed.set(specifier, absolute);
      return next(pathToFileURL(absolute).href, context);
    }
    return next(specifier, context);
  },
});
process.on("exit", () => {
  if (process.env.PI_CLOUD_REVIEW_SOURCE_AUDIT)
    writeFileSync(
      process.env.PI_CLOUD_REVIEW_SOURCE_AUDIT,
      JSON.stringify({ root, routed: [...routed] }, null, 2) + "\n",
    );
});
