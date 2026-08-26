import { readFileSync, writeFileSync } from "node:fs";

import { analyse } from "../src/pipeline.ts";
import { parseClip, type ParseOptions } from "../src/io/clip.ts";

/**
 * Analyses a clip file and prints what came out.
 *
 *   node --experimental-strip-types tools/analyse-clip.ts meinclip.json [--json bericht.json]
 *                                   [--depth absolute|rootRelative] [--depth-sigma 0.055]
 *
 * The point of this tool is that it is the same call the tests make. Nothing is
 * special-cased for real footage: if the report says a quantity is not
 * measurable from your clip, that is the engine's judgement about your clip.
 */

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
if (!path) {
  console.error(
    "Aufruf: node --experimental-strip-types tools/analyse-clip.ts <clip.json> [--json <datei>] " +
      "[--depth absolute|rootRelative] [--depth-sigma <meter>]",
  );
  process.exit(1);
}

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const options: ParseOptions = {
  depthMode: (flag("depth") as ParseOptions["depthMode"]) ?? "rootRelative",
  depthSigmaM: flag("depth-sigma") ? Number(flag("depth-sigma")) : undefined,
};

const { request, depthPrior, warnings } = parseClip(JSON.parse(readFileSync(path, "utf8")), options);

const rule = (title: string) => {
  console.log("\n" + "─".repeat(78));
  console.log(title);
  console.log("─".repeat(78));
};

rule("EINGANG");
console.log(
  `  ${request.video.widthPx}×${request.video.heightPx}, ${request.video.fps} fps ` +
    `(aufgenommen mit ${request.video.captureFps} fps), ${request.frames.length} Bilder` +
    (request.video.hfovDeg ? `, Bildwinkel ${request.video.hfovDeg}°` : ", Bildwinkel unbekannt"),
);
console.log(
  `  ${request.player.displayName}, ${request.player.heightCm} cm, ${request.player.hand}, ` +
    `Niveau ${request.player.level}`,
);
console.log(
  `  Schlag: ${request.stroke}` +
    (request.hints?.contactFrame !== undefined
      ? `, Treffpunkt markiert bei Bild ${request.hints.contactFrame}`
      : ", Treffpunkt nicht markiert"),
);
console.log(`  Tiefenprior: ${depthPrior ? depthPrior.id : "keiner"}`);

if (warnings.length) {
  rule("HINWEISE ZUR DATEI");
  for (const w of warnings) console.log("  · " + w);
}

const started = Date.now();
const { report, intermediates } = analyse(request, { depthPrior });
const elapsed = Date.now() - started;

rule("ERGEBNIS");
console.log(`  ${report.verdict.statement}`);
for (const reason of report.verdict.reasons) console.log("    – " + reason);
console.log(`\n  Analysequalität ${report.quality.overall}/100`);
for (const c of report.quality.components) {
  console.log(
    `    ${c.label.padEnd(22)} ${c.applicable === false ? "n. v.".padStart(5) : String(c.score).padStart(3)}` +
      (c.applicable === false ? "  (im Material nicht enthalten)" : ""),
  );
}
console.log(
  `\n  Treffpunkt: ${report.contactFrame === null ? "nicht bestimmt" : `Bild ${report.contactFrame.toFixed(1)}`}` +
    ` (Vertrauen ${Math.round(report.contactConfidence * 100)} %)`,
);
console.log(
  `  Tiefenrichtung gesichert: ${Math.round(intermediates.mirrorConfidence * 100)} % · ` +
    `Vertikale: ${Math.round(intermediates.verticalConfidence * 100)} %`,
);

rule("MESSWERTE");
if (!report.metrics.length) console.log("  (keine)");
for (const m of report.metrics) {
  const flagText = m.rejected ? "VERWORFEN" : m.confidence >= 0.6 ? "" : "nur orientierend";
  console.log(
    `  ${m.label.padEnd(34)} ${m.formatted.padStart(20)}  ${m.confidenceLabel.padEnd(8)} ` +
      `${m.observability.padEnd(14)} ${flagText}`,
  );
  if (m.rejected && m.rejectionReason) console.log(`      ${m.rejectionReason}`);
}

if (report.notMeasurable.length) {
  rule("NICHT MESSBAR");
  for (const n of report.notMeasurable) console.log(`  ${n.label}: ${n.reason}`);
}

if (report.findings.length) {
  rule("BEFUNDE");
  for (const f of report.findings) {
    console.log(`  ${f.observation}`);
    console.log(`     Deutung:    ${f.interpretation}`);
    console.log(`     Konsequenz: ${f.consequence}`);
    console.log(`     Vorschlag:  ${f.recommendation}`);
    console.log(`     Vertrauen:  ${f.confidenceLabel}\n`);
  }
}

rule("PIPELINE");
for (const layer of report.pipeline) {
  console.log(
    `  ${layer.id.padEnd(4)} ${layer.name.padEnd(30)} ${layer.status.padEnd(9)} ` +
      `${Math.round(layer.quality * 100)}%`,
  );
  for (const note of layer.notes) console.log(`         ${note}`);
}

if (report.issues.length) {
  rule("PLAUSIBILITÄT");
  for (const issue of report.issues) {
    console.log(`  [${issue.severity}] ${issue.statement}`);
    for (const e of issue.evidence) console.log(`      ${e}`);
  }
}

const jsonPath = flag("json");
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\nBericht geschrieben: ${jsonPath}`);
}

console.log(`\nRechenzeit: ${(elapsed / 1000).toFixed(1)} s\n`);
