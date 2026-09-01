import { readFileSync, writeFileSync } from "node:fs";

const fonts = JSON.parse(readFileSync("fonts.json", "utf8"));
const skeleton = readFileSync("skeleton.json", "utf8");
const body = readFileSync("ad-body.html", "utf8");
const figure = readFileSync("figure.js", "utf8");
const script = readFileSync("ad.js", "utf8");

// Screens of the app actually running, carried into the page so the film needs
// nothing from the network while it is being recorded.
const png = (file) => "data:image/png;base64," + readFileSync(file).toString("base64");
const images = {
  metrics: png("app-metrics.png"),
  verdict: png("app-verdict.png"),
};
// What capture-app.mjs read off the same run that produced those pictures:
// which part of each screen the film frames, and the figures it says out loud.
// A re-capture that reflows the layout carries the frame with it, and a run
// that lands on different numbers changes the words too.
const capture = JSON.parse(readFileSync("app-capture.json", "utf8"));

/** 65.1 ± 7.2 ° → 65,1 ± 7,2° */
const german = (s) => s.replace(/(\d),(\d)/g, "$1$2").replace(/\./g, ",").replace(/\s+°/, "°");
const filled = body
  .replace(/\{\{WERT\}\}/g, german(capture.facts.metricValue))
  .replace(/\{\{QUALITAET\}\}/g, capture.facts.quality)
  .replace(/\{\{BELASTBAR\}\}/g, capture.facts.usable);

const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8" />
<style>
@font-face{font-family:Archivo;font-weight:600;font-display:block;src:url(data:font/woff2;base64,${fonts.archivo600}) format("woff2")}
@font-face{font-family:Archivo;font-weight:700;font-display:block;src:url(data:font/woff2;base64,${fonts.archivo700}) format("woff2")}
@font-face{font-family:PlexMono;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${fonts.mono400}) format("woff2")}
@font-face{font-family:PlexMono;font-weight:500;font-display:block;src:url(data:font/woff2;base64,${fonts.mono500}) format("woff2")}
</style>
</head><body>
${filled}
<script>window.SKELETON = ${skeleton};</script>
<script>window.__ADIMG = ${JSON.stringify(images)};</script>
<script>window.__ADREGION = ${JSON.stringify(capture.regions)};</script>
<script>${figure}</script>
<script>${script}</script>
</body></html>`;

writeFileSync("ad.html", html);
console.log("ad.html", (html.length / 1024 / 1024).toFixed(2), "MB");
