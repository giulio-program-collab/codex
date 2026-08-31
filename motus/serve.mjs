/**
 * Ein Server, der nichts kann außer Dateien ausliefern.
 *
 * Nötig, weil ES-Module und WebAssembly aus `file://` nicht laden — nicht aus
 * Bosheit, sondern weil der Browser für beides eine Herkunft braucht.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8100);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".css": "text/css; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    let path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) throw new Error("außerhalb");
    if ((await stat(path)).isDirectory()) path = join(path, "index.html");
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "content-length": body.length,
      // Nötig, damit der Browser SharedArrayBuffer erlaubt; MediaPipe läuft
      // damit spürbar schneller.
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nicht gefunden");
  }
}).listen(PORT, () => console.log(`MOTUS läuft auf http://localhost:${PORT}/`));
