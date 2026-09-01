import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { bundle } from "./bundle.ts";

/**
 * Builds the page that carries the pose estimator inside itself.
 *
 * The published playground may not fetch anything from anywhere, so a route
 * that loads a model at run time cannot work there — and that route is the only
 * one anybody actually wants. Everything therefore goes into the file:
 *
 *   vision_wasm_internal.js   210 kB, inlined as a plain script; it defines the
 *                             `ModuleFactory` global the bundle looks for, so
 *                             the bundle never has to load a script itself.
 *   vision_bundle.mjs         137 kB, its `export {}` rewritten to a global, so
 *                             it too can be a plain script rather than a module
 *                             fetched from a blob URL.
 *   the WebAssembly           9.4 MB, gzipped and base64-encoded to 3.6 MB, and
 *                             handed to Emscripten as `Module.wasmBinary` so it
 *                             is never fetched.
 *   the pose model            5.5 MB, likewise, passed as `modelAssetBuffer`.
 *
 * Around eleven megabytes in total, against a sixteen-megabyte ceiling.
 *
 *   node --experimental-strip-types tools/build-video-artifact.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = join(here, "..");
const playgroundDir = join(engineDir, "..", "playground");
const vendorDir = join(playgroundDir, "vendor");

for (const file of ["vision_bundle.mjs", "vision_wasm_internal.js", "vision_wasm_internal.wasm", "pose_landmarker_lite.task"]) {
  if (!existsSync(join(vendorDir, file))) {
    throw new Error(`${file} fehlt in playground/vendor. Erst tools/fetch-models.ts ausführen.`);
  }
}

/**
 * Turns the ES module into a classic script.
 *
 * Its last statement is a single `export { a as B, c as D }`, which is exactly
 * enough information to rebuild the same names on a global instead.
 */
function toClassicScript(source: string): string {
  const match = source.match(/export\{([^}]*)\}/);
  if (!match) throw new Error("Im MediaPipe-Bundle wurde keine export-Anweisung gefunden.");
  const pairs = match[1]
    .split(",")
    .map((entry) => entry.trim().split(/\s+as\s+/))
    .filter((parts) => parts.length === 2)
    .map(([local, exported]) => `${exported}:${local}`);
  return source.replace(match[0], `globalThis.__mpVision={${pairs.join(",")}}`);
}

const packed = (file: string): string => gzipSync(readFileSync(join(vendorDir, file)), { level: 9 }).toString("base64");

const engine = bundle(join(engineDir, "playground", "entry.ts"), {
  globalName: "BaselineVision",
  root: engineDir,
});
const template = readFileSync(join(playgroundDir, "template.html"), "utf8");
const app = readFileSync(join(playgroundDir, "app.js"), "utf8");
const videoApp = readFileSync(join(playgroundDir, "video-app.js"), "utf8");

const loader = readFileSync(join(vendorDir, "vision_wasm_internal.js"), "utf8");
const visionBundle = toClassicScript(readFileSync(join(vendorDir, "vision_bundle.mjs"), "utf8"));
const wasm64 = packed("vision_wasm_internal.wasm");
const model64 = packed("pose_landmarker_lite.task");

for (const [name, text] of [["Loader", loader], ["Bundle", visionBundle]] as const) {
  if (/<\/script/i.test(text)) throw new Error(`${name} enthält ein </script; die Seite würde zerbrechen.`);
}

const estimator = `
<script>
${loader}
// The bundle clears this global after it uses it; keep a copy so a second
// attempt (CPU after GPU, say) still finds it.
window.__BV_MODULE_FACTORY = ModuleFactory;
</script>
<script>
${visionBundle}
</script>
<script>
window.__BV_ASSETS = { wasm: "${wasm64}", model: "${model64}" };
</script>
`;

const fragment = template
  .replace("<!--ENGINE-->", engine)
  .replace("<!--APP-->", app)
  .replace("</body>", "</body>");

const withEstimator = fragment.replace(
  '<script id="engine-source"',
  `${estimator}\n<script id="engine-source"`,
) + `\n<script>\n${videoApp}\n</script>\n`;

const asDocument = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${withEstimator.slice(0, withEstimator.indexOf("</style>") + "</style>".length)}
</head>
<body>
${withEstimator.slice(withEstimator.indexOf("</style>") + "</style>".length)}
</body>
</html>
`;

writeFileSync(join(playgroundDir, "artifact-video.html"), withEstimator);
writeFileSync(join(playgroundDir, "video-standalone.html"), asDocument);

const mb = (s: string) => (s.length / 1024 / 1024).toFixed(1) + " MB";
console.log(`WebAssembly (gz, base64)  ${mb(wasm64)}`);
console.log(`Pose-Modell (gz, base64)  ${mb(model64)}`);
console.log(`artifact-video.html       ${mb(withEstimator)}`);
console.log(`video-standalone.html     ${mb(asDocument)}`);
if (withEstimator.length > 16 * 1024 * 1024) {
  throw new Error("Die Seite überschreitet die 16-MB-Grenze für Artifacts.");
}
