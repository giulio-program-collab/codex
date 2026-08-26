import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";

/**
 * A static server for the playground, in fifty lines and with no dependencies.
 *
 * The video app needs one: browsers refuse to instantiate WebAssembly from a
 * `file://` page, so opening the HTML from disk cannot work however the page is
 * written. This serves the playground directory and nothing else.
 *
 *   node --experimental-strip-types tools/serve.ts [port]
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "playground");
const port = Number(process.argv[2] ?? 8080);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = url.pathname === "/" ? "/video.html" : url.pathname;
  const path = join(root, normalize(requested).replace(/^(\.\.[/\\])+/, ""));

  if (!path.startsWith(root) || !existsSync(path) || statSync(path).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Nicht gefunden: ${requested}`);
    return;
  }

  res.writeHead(200, {
    "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    "content-length": statSync(path).size,
    // The pose runtime uses threads, which browsers only allow on a
    // cross-origin-isolated page.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cache-control": "no-cache",
  });
  createReadStream(path).pipe(res);
});

server.listen(port, () => {
  console.log(`Prüfstand läuft auf http://localhost:${port}/`);
  console.log(`  /video.html   Video hineinziehen, Analyse ansehen`);
  console.log(`  /index.html   Simulation und Clip-Dateien`);
  console.log(`\nBeenden mit Strg-C.`);
});
