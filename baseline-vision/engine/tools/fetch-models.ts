import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Fetches the pose estimator the browser app runs.
 *
 * The model and its WebAssembly runtime are fifteen megabytes and they belong
 * to Google, not to this project, so they are downloaded rather than checked
 * in. Everything lands in `playground/vendor/`, which is ignored by git.
 *
 *   node --experimental-strip-types tools/fetch-models.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, "..", "..", "playground", "vendor");

const NPM = "https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.14.tgz";

interface Asset {
  url: string;
  file: string;
  note: string;
}

const ASSETS: Asset[] = [
  {
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    file: "pose_landmarker_full.task",
    note: "Pose-Modell (33 Landmarks, inkl. metrischer 3D-Schätzung)",
  },
  {
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    file: "pose_landmarker_lite.task",
    note: "Kleineres Pose-Modell, schneller und ungenauer",
  },
];

async function download(url: string, target: string): Promise<number> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(target));
  return statSync(target).size;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + " MB";

mkdirSync(vendorDir, { recursive: true });

for (const asset of ASSETS) {
  const target = join(vendorDir, asset.file);
  if (existsSync(target) && statSync(target).size > 0) {
    console.log(`${asset.file.padEnd(34)} bereits vorhanden (${mb(statSync(target).size)})`);
    continue;
  }
  process.stdout.write(`${asset.file.padEnd(34)} lädt … `);
  const size = await download(asset.url, target);
  console.log(`${mb(size)} — ${asset.note}`);
}

// The runtime ships inside the npm tarball; extracting two files from it beats
// depending on a CDN that the page would then have to reach at run time.
const runtimeFiles = [
  "package/wasm/vision_wasm_internal.js",
  "package/wasm/vision_wasm_internal.wasm",
  "package/wasm/vision_wasm_nosimd_internal.js",
  "package/wasm/vision_wasm_nosimd_internal.wasm",
  "package/vision_bundle.mjs",
];

const needsRuntime = runtimeFiles.some(
  (f) => !existsSync(join(vendorDir, f.replace("package/wasm/", "").replace("package/", ""))),
);

if (!needsRuntime) {
  console.log("MediaPipe-Laufzeit                  bereits vorhanden");
} else {
  process.stdout.write("MediaPipe-Laufzeit                 lädt … ");
  const tarball = join(vendorDir, "tasks-vision.tgz");
  const size = await download(NPM, tarball);
  const { execFileSync } = await import("node:child_process");
  execFileSync("tar", ["xzf", tarball, "-C", vendorDir, ...runtimeFiles], { stdio: "inherit" });
  for (const f of runtimeFiles) {
    const from = join(vendorDir, f);
    const to = join(vendorDir, f.replace("package/wasm/", "").replace("package/", ""));
    execFileSync("mv", [from, to]);
  }
  execFileSync("rm", ["-rf", join(vendorDir, "package"), tarball]);
  console.log(`${mb(size)} entpackt`);
}

console.log(`\nAlles liegt in ${vendorDir}.`);
console.log("Starten mit: node --experimental-strip-types tools/serve.ts");
