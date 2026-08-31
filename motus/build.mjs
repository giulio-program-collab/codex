/**
 * Baut MOTUS zu einer einzigen Datei.
 *
 * Die Fassung mit Ordner braucht einen Server: ES-Module und WebAssembly laden
 * nicht aus `file://`. Auf einer Sportanlage einen Server zu starten ist keine
 * realistische Erwartung, also gibt es `motus.html` — eine Datei, die man
 * doppelklickt, und in der alles steckt:
 *
 *   der eigene Code           die neun Module aus src/, zu einem Skript
 *                             zusammengeschrieben statt als Module geladen
 *   vision_wasm_internal.js   210 kB, definiert die Globale `ModuleFactory`
 *   vision_bundle.mjs         137 kB, sein `export{}` in eine Globale gedreht,
 *                             damit es ein gewöhnliches Skript sein kann
 *   das WebAssembly           9,4 MB, gepackt und base64-kodiert; wird als
 *                             `Module.wasmBinary` übergeben statt geladen
 *   das Pose-Modell           5,8 MB, ebenso, als `modelAssetBuffer`
 *
 * Zusammen rund 12 MB. Das ist viel für eine HTML-Datei und wenig für ein
 * Werkzeug, das ohne Internet, ohne Installation und ohne Server läuft.
 *
 *   node build.mjs
 */
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = process.cwd();
const src = (f) => readFileSync(join(here, "src", f), "utf8");
const vendor = (f) => join(here, "vendor", f);

/* --- 1. Den eigenen Code zu einem Skript zusammenschreiben ---------- */

/**
 * Ein Bündler für genau diesen Fall.
 *
 * Alle Module liegen flach in einem Ordner, hängen zyklenfrei voneinander ab
 * und benutzen durchweg eindeutige Namen auf oberster Ebene. Unter diesen drei
 * Bedingungen genügt es, die Dateien in Abhängigkeitsreihenfolge aneinander zu
 * hängen und `import`- und `export`-Zeilen zu streichen — der Rest ist gültiges
 * JavaScript. Ein allgemeiner Bündler wäre hier mehr Werkzeug als Aufgabe.
 */
const ORDER = [
  "03-clean.js",
  "04-angles.js",
  "05-reps.js",
  "06-report.js",
  "01-frames.js",
  "02-pose.js",
  "ui-overlay.js",
  "ui-chart.js",
  "app.js",
];

const modules = ORDER.map((file) => {
  const text = src(file)
    .replace(/^\s*import\s[^;]*?;\s*$/gm, "")
    .replace(/^export\s+(?=(const|let|function|class|async))/gm, "");
  return `/* ===== src/${file} ===== */\n${text}`;
}).join("\n");

/**
 * Gekapselt, nicht global.
 *
 * Klassische Skripte teilen sich einen lexikalischen Gültigkeitsbereich: Ein
 * `const $` auf oberster Ebene kollidiert mit jedem anderen `const $` auf einer
 * Seite — auch mit einem, das in Googles minifiziertem Bundle steht. Die Datei
 * lud daraufhin gar nicht, mit einer Fehlermeldung, die auf nichts Eigenes
 * zeigte. Ein umschließender Ausdruck macht daraus lokale Namen und gibt nur
 * das eine heraus, das gebraucht wird.
 */
const stripped = `const MOTUS = (() => {\n${modules}\nreturn { start };\n})();`;

// Die Namen prüfen, statt zu hoffen: Ein zweites `const LINE` in einer zweiten
// Datei wäre im Modulsystem harmlos und hier ein Fehler beim Laden.
const declared = new Map();
for (const file of ORDER) {
  for (const m of src(file).matchAll(/^(?:export\s+)?(?:const|let|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (declared.has(name)) {
      throw new Error(`Der Name "${name}" steht in ${declared.get(name)} und in ${file}.`);
    }
    declared.set(name, file);
  }
}

/* --- 2. Die Bibliothek von Google einbetten ------------------------- */

/**
 * Macht aus dem ES-Modul ein gewöhnliches Skript.
 *
 * Seine letzte Anweisung ist ein einziges `export{a as B, c as D}` — genau die
 * Information, die nötig ist, um dieselben Namen stattdessen an eine Globale zu
 * hängen.
 */
function toClassicScript(source) {
  const match = source.match(/export\{([^}]*)\}/);
  if (!match) throw new Error("Im MediaPipe-Bundle steht keine export-Anweisung.");
  const pairs = match[1]
    .split(",")
    .map((e) => e.trim().split(/\s+as\s+/))
    .filter((p) => p.length === 2)
    .map(([local, exported]) => `${exported}:${local}`);
  return source.replace(match[0], `globalThis.__motusVision={${pairs.join(",")}}`);
}

const packed = (file) => gzipSync(readFileSync(vendor(file)), { level: 9 }).toString("base64");

const loader = readFileSync(vendor("vision_wasm_internal.js"), "utf8");
const visionBundle = toClassicScript(readFileSync(vendor("vision_bundle.mjs"), "utf8"));
const wasm64 = packed("vision_wasm_internal.wasm");
const model64 = packed("pose_landmarker_lite.task");

for (const [name, text] of [["Loader", loader], ["Bundle", visionBundle], ["MOTUS", stripped]]) {
  if (/<\/script/i.test(text)) throw new Error(`${name} enthält ein </script — die Seite zerbräche daran.`);
}

/* --- 3. Alles in die Seite ----------------------------------------- */

const page = readFileSync(join(here, "index.html"), "utf8");
const head = page.slice(0, page.indexOf("</head>"));
const bodyStart = page.indexOf("<body>") + "<body>".length;
const bodyEnd = page.indexOf('<script type="module">');
const body = page.slice(bodyStart, bodyEnd);

const boot = `
<script>${loader}
// Das Bundle räumt diese Globale nach Gebrauch weg; eine Kopie bleibt, damit
// ein zweiter Versuch (etwa CPU nach GPU) sie noch findet.
window.__motusModuleFactory = ModuleFactory;
</script>
<script>${visionBundle}</script>
<script id="motus-assets" type="application/octet-stream">${wasm64}
${model64}</script>
<script>
${stripped}

/** Base64 → gepackte Bytes → entpackte Bytes, ohne Umweg über das Netz. */
async function unpack(b64) {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

(async () => {
  const [wasm64, model64] = document.getElementById("motus-assets").textContent.trim().split("\\n");
  const [wasmBinary, modelBuffer] = await Promise.all([unpack(wasm64), unpack(model64)]);
  // Emscripten sucht beides an diesen Globalen. Sind sie gesetzt, lädt es
  // nichts nach — und genau das ist der Sinn dieser Datei.
  self.ModuleFactory = window.__motusModuleFactory;
  self.Module = { wasmBinary };
  MOTUS.start({ vision: globalThis.__motusVision, modelBuffer });
})();
</script>`;

const out = `${head}</head>
<body>${body}${boot}
</body>
</html>
`;

writeFileSync(join(here, "motus.html"), out);
const mb = (s) => (s.length / 1024 / 1024).toFixed(1) + " MB";
console.log(`Code             ${(stripped.length / 1024).toFixed(0)} kB`);
console.log(`WebAssembly      ${mb(wasm64)} (gepackt, base64)`);
console.log(`Pose-Modell      ${mb(model64)} (gepackt, base64)`);
console.log(`motus.html       ${mb(out)}`);
