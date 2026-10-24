// Bundles the extension's scripts into extension/dist. Run: npm run build:extension
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: { fill: "src/fill.ts", panel: "src/panel.ts", background: "src/background.ts" },
  absWorkingDir: here,
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome114",
  logLevel: "warning",
});
console.log("Extension built in extension/dist. Load the extension/ folder in chrome://extensions (Developer mode → Load unpacked).");
