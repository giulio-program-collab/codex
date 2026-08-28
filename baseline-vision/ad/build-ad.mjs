import { readFileSync, writeFileSync } from "node:fs";
const fonts = JSON.parse(readFileSync("fonts.json", "utf8"));
const skeleton = readFileSync("skeleton.json", "utf8");
const body = readFileSync("ad-body.html", "utf8");
const script = readFileSync("ad.js", "utf8");
const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8" />
<style>
@font-face{font-family:Archivo;font-weight:600;font-display:block;src:url(data:font/woff2;base64,${fonts.archivo600}) format("woff2")}
@font-face{font-family:Archivo;font-weight:700;font-display:block;src:url(data:font/woff2;base64,${fonts.archivo700}) format("woff2")}
@font-face{font-family:PlexMono;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${fonts.mono400}) format("woff2")}
@font-face{font-family:PlexMono;font-weight:500;font-display:block;src:url(data:font/woff2;base64,${fonts.mono500}) format("woff2")}
</style>
</head><body>
${body}
<script>window.SKELETON = ${skeleton};</script>
<script>${script}</script>
</body></html>`;
writeFileSync("ad.html", html);
console.log("ad.html", (html.length / 1024).toFixed(0), "kB");
