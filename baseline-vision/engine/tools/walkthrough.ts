import { analyse } from "../src/pipeline.ts";
import { buildScenario, GOOD_CAPTURE, type ScenarioOptions } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS, generateServe } from "../src/fixtures/serve-model.ts";
import { CAMERA_RIGS, cameraFromRig } from "../src/fixtures/render.ts";
import { project } from "../src/core/camera.ts";
import { clamp } from "../src/core/math.ts";
import { JOINTS, type Joint } from "../src/core/types.ts";
import { methodBiasFor } from "../src/layers/l10-features.ts";

/**
 * A single serve, traced through the whole chain.
 *
 * Written to be read rather than to be fast: it prints what goes in, what each
 * layer makes of it, how one measurement is assembled, and how the verdict
 * follows — next to what the old tool does with the very same clip.
 *
 *   node --experimental-strip-types tools/walkthrough.ts [elite|developing]
 */

const preset = (process.argv[2] ?? "elite") as keyof typeof SERVE_PRESETS;
const NOW = "2026-08-24T10:15:00Z";

const rule = (title: string) => {
  console.log("\n" + "─".repeat(78));
  console.log(title);
  console.log("─".repeat(78));
};
const kv = (k: string, v: unknown) => console.log("  " + k.padEnd(38) + String(v));
const pct = (x: number) => Math.round(x * 100) + " %";

/* ------------------------------------------------------------------ */
/* Step 0 — what we are looking at                                     */
/* ------------------------------------------------------------------ */

const options: ScenarioOptions = {
  preset,
  level: preset === "elite" ? "elite" : "junior_development",
  rig: "elevatedSide",
  fps: 240,
  ageYears: preset === "elite" ? 24 : 13,
  knownFieldOfView: true,
  learnedDepth: true,
  render: GOOD_CAPTURE,
};
const scenario = buildScenario("walkthrough", "Durchlauf", options);
const truth = generateServe(SERVE_PRESETS[preset], 480);
const contactIndexTruth = Math.round(SERVE_PRESETS[preset].contactT * 480);

rule("SCHRITT 0 · Was hineingeht");
kv("Aufnahme", `${scenario.request.video.widthPx}×${scenario.request.video.heightPx}, ` +
  `${scenario.request.video.fps} fps, ${scenario.request.frames.length} Bilder`);
kv("Kamera", "erhöht seitlich, 8 m Abstand, Brennweite bekannt");
kv("Spieler", `${scenario.request.player.heightCm} cm, ${scenario.request.player.hand}, ` +
  `Niveau ${scenario.request.player.level}`);
console.log(
  "\n  Die Fixture kennt die Wahrheit, das System nicht. Es bekommt nur 2D-Gelenke\n" +
    "  mit Detektor-Scores, so wie sie ein echter Pose-Estimator liefert:",
);
const sample = scenario.request.frames[Math.round(SERVE_PRESETS[preset].contactT * 240)];
for (const j of ["shoulderR", "elbowR", "wristR"] as Joint[]) {
  const kp = sample.pose2d[j];
  if (kp) kv("  " + j, `(${kp.p.x.toFixed(0)}, ${kp.p.y.toFixed(0)}) px · Score ${kp.score.toFixed(2)}`);
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

const { report, intermediates } = analyse(scenario.request, {
  now: NOW,
  depthPrior: scenario.depthPrior,
});
const layer = (id: string) => report.pipeline.find((l) => l.id === id)!;

/* ------------------------------------------------------------------ */
/* Steps 1-9 — the chain                                               */
/* ------------------------------------------------------------------ */

rule("SCHRITT 1-2 · Qualitäts-Gate und Kalibrierung");
kv("L1 Ingestion", `${layer("L1").status} · ${layer("L1").diagnostics.effectiveHz} Hz Szenenrate`);
kv("Zeitmessung zulässig?", layer("L1").diagnostics.timingAllowed);
kv("L2 Brennweitenquelle", layer("L2").diagnostics.brennweiteQuelle);
kv("L2 Distanz zum Spieler", layer("L2").diagnostics.distanzM + " m ± " +
  layer("L2").diagnostics.distanzUnsicherheitProzent + " %");
kv("L2 Kameraposition (gemessen)", layer("L2").diagnostics.kameraposition);
console.log(
  "\n  Der Maßstab ist keine Konstante: m/px = Tiefe / Brennweite. Das alte Werkzeug\n" +
    "  benutzt hier eine einzige Zahl aus zwei Klicks am stehenden Spieler.",
);

rule("SCHRITT 3-5 · Tracking und Bereinigung");
kv("Verworfene Stichproben", layer("L5").diagnostics.verworfeneStichproben +
  ` (${layer("L5").diagnostics.verwerfungsrateProzent} %)`);
kv("  davon unmögliche Geschwindigkeit", layer("L5").diagnostics.unmoeglicheGeschwindigkeit);
kv("  davon Spitzen", layer("L5").diagnostics.spitzen);
kv("  davon Knochenlängenverstoß", layer("L5").diagnostics.knochenlaenge);
kv("Links/Rechts-Vertauschungen", layer("L5").diagnostics.limbSwapUebergaenge);
kv("Über Lücken interpoliert", layer("L5").diagnostics.interpoliert);

rule("SCHRITT 6 · 3D-Rekonstruktion");
kv("Knochenlängenfehler", layer("L6").diagnostics.knochenlaengenfehlerProzent +
  " %  (brauchbar bis 7 %, unbrauchbar ab 15 %)");
kv("Geometrisch unmögliche Segmente", layer("L6").diagnostics.unmoeglicheSegmenteProzent + " %");
kv("Quelle der Vertikalen", layer("L6").diagnostics.vertikaleQuelle);
kv("  implizite Schwerkraft", layer("L6").diagnostics.schwerkraftMs2 + " m/s²  (Sollwert 9,81)");
kv("  Abweichung der zwei Schätzungen", layer("L6").diagnostics.vertikaleAbweichungGrad + "°");
kv("Sicherheit der Tiefenrichtung", layer("L6").diagnostics.spiegelungsSicherheit);
console.log(
  "\n  Die Schwerkraft aus dem Ballwurf ist die einzige Größe im Video, deren\n" +
    "  Richtung a priori bekannt ist. Ihre Richtung liefert die Vertikale auf\n" +
    "  wenige Grad genau; ihr Betrag ist eine grobe, aber unabhängige Kontrolle\n" +
    "  der Skalenkette — er darf nicht weit von 9,81 abweichen, ist aber selbst\n" +
    "  auf etwa 10 % genau und taugt nicht zur Feinkalibrierung.",
);

// Reconstruction error against the truth the fixture kept to itself.
//
// The court frame's "toward the target" axis is estimated from the player's own
// shoulders and is only good to a few tens of degrees, so a single best-fit
// rotation about the vertical is removed first. Leaving it in would measure
// that axis estimate rather than the reconstruction, and report half a metre
// where the shape error is under five centimetres.
const jointErrorAtYaw = (degrees: number, step: number): number => {
  const c = Math.cos((degrees * Math.PI) / 180);
  const s = Math.sin((degrees * Math.PI) / 180);
  let total = 0;
  let count = 0;
  for (let i = 0; i < intermediates.poses3d.length; i += step) {
    const t = truth.frames[Math.min(truth.frames.length - 1, Math.round((i / 240) * 480))];
    const root = intermediates.poses3d[i]?.pelvis?.p;
    if (!root) continue;
    for (const j of JOINTS) {
      const r = intermediates.poses3d[i]?.[j]?.p;
      if (!r) continue;
      const dx = r.x - root.x;
      const dy = r.y - root.y;
      const dz = r.z - root.z;
      const rx = c * dx - s * dy;
      const ry = s * dx + c * dy;
      const tx = t.joints[j].x - t.joints.pelvis.x;
      const ty = t.joints[j].y - t.joints.pelvis.y;
      const tz = t.joints[j].z - t.joints.pelvis.z;
      total += Math.hypot(rx - tx, ry - ty, dz - tz);
      count++;
    }
  }
  return count > 0 ? total / count : Number.POSITIVE_INFINITY;
};
let bestYaw = 0;
let bestError = Number.POSITIVE_INFINITY;
for (let d = -180; d < 180; d += 2) {
  const e = jointErrorAtYaw(d, 6);
  if (e < bestError) {
    bestError = e;
    bestYaw = d;
  }
}
const jointError = jointErrorAtYaw(bestYaw, 2);
kv("Mittlerer Gelenkfehler", (jointError * 1000).toFixed(0) + " mm gegen Ground Truth");
kv("  (Gierdrehung des Platzsystems)", bestYaw.toFixed(0) + "° herausgerechnet");

rule("SCHRITT 9 · Segmentierung und Treffpunkt");
kv("Treffpunkt (gemessen)", `Bild ${report.contactFrame?.toFixed(1)} · Sicherheit ${pct(report.contactConfidence)}`);
kv("Treffpunkt (Wahrheit)", `Bild ${(SERVE_PRESETS[preset].contactT * 240).toFixed(1)}`);
kv("Abweichung", report.contactFrame !== null
  ? (((report.contactFrame - SERVE_PRESETS[preset].contactT * 240) / 240) * 1000).toFixed(1) + " ms"
  : "—");
console.log("");
for (const p of report.phases) {
  console.log(
    "  " + p.label.padEnd(24) +
      `Bild ${p.startFrame.toFixed(0).padStart(4)}–${p.endFrame.toFixed(0).padStart(4)}` +
      `   Sicherheit ${pct(p.confidence)}`,
  );
}

/* ------------------------------------------------------------------ */
/* Step 10 — one measurement, taken apart                              */
/* ------------------------------------------------------------------ */

rule("SCHRITT 10 · Eine Messung, auseinandergenommen: Knieflexion");
const knee = report.metrics.find((m) => m.id === "kneeFlexionPeak");
const truthKnee = SERVE_PRESETS[preset].kneeFlexPeakDeg;
if (knee && knee.value !== null) {
  kv("Gemessen", knee.formatted);
  kv("95-%-Intervall", knee.interval95 ? `${knee.interval95[0].toFixed(1)} … ${knee.interval95[1].toFixed(1)}°` : "—");
  kv("Wahrheit (nur der Fixture bekannt)", truthKnee.toFixed(1) + "°");
  kv("Liegt die Wahrheit im Intervall?", knee.interval95 &&
    truthKnee >= knee.interval95[0] && truthKnee <= knee.interval95[1] ? "ja" : "NEIN");
  console.log("");
  kv("Woraus die Unsicherheit besteht:", "");
  const bias = methodBiasFor("kneeFlexionPeak");
  const mc = Math.sqrt(Math.max(0, (knee.sd ?? 0) ** 2 - bias ** 2));
  kv("  Typ A · Monte-Carlo über 120 Replikate", "± " + mc.toFixed(2) + "°");
  kv("  Typ B · gemessener Restsystematik", "± " + bias.toFixed(2) + "°");
  kv("  quadratisch addiert", "± " + (knee.sd ?? 0).toFixed(2) + "°");
  console.log("");
  kv("Confidence", pct(knee.confidence) + " · " + knee.confidenceLabel);
  kv("Beobachtbarkeit", knee.observability);
  if (knee.reference) {
    console.log("");
    kv("Referenz", `${knee.reference.mean.toFixed(1)}° · kombinierte SD ${knee.reference.combinedSd.toFixed(1)}°`);
    kv("z-Wert", knee.reference.z?.toFixed(2));
    kv("Einordnung", knee.reference.deviation);
    for (const r of knee.reference.cohortReasons) console.log("    · " + r);
  }
}

rule("SCHRITT 10b · Was bewusst nicht gemessen wird");
for (const nm of report.notMeasurable) {
  console.log("  " + nm.label);
  console.log("    " + nm.reason.replace(/\s+/g, " ").slice(0, 150));
}

/* ------------------------------------------------------------------ */
/* Steps 12-13 — quality and verdict                                   */
/* ------------------------------------------------------------------ */

rule("SCHRITT 12-13 · Qualität, Plausibilität, Urteil");
kv("Analysequalität", report.quality.overall + "/100");
for (const c of report.quality.components) kv("  " + c.label, c.score + "/100");
console.log("");
for (const i of report.issues) {
  console.log(`  [${i.severity}] ${i.statement.replace(/\s+/g, " ").slice(0, 140)}`);
}
console.log("");
kv("Urteil", report.verdict.kind === "assessment"
  ? `${report.verdict.score}/100 · Sicherheit ${pct(report.verdict.confidence ?? 0)}`
  : report.verdict.headline);
for (const c of report.verdict.components ?? []) {
  kv("  " + c.label, `${c.score}/100 · Gewicht ${pct(c.weight)} · aus ${c.basedOn.join(", ")}`);
}
for (const r of report.verdict.reasons) console.log("    · " + r.replace(/\s+/g, " ").slice(0, 150));

console.log("");
for (const f of report.findings) {
  console.log("  BEFUND · Sicherheit " + pct(f.confidence));
  console.log("    Beobachtung    " + f.observation.replace(/\s+/g, " "));
  console.log("    Interpretation " + f.interpretation.replace(/\s+/g, " ").slice(0, 130));
  console.log("    Konsequenz     " + f.consequence.replace(/\s+/g, " ").slice(0, 130));
  console.log("    Empfehlung     " + f.recommendation.replace(/\s+/g, " ").slice(0, 130));
}
if (report.findings.length === 0) console.log("  Keine Befunde.");

/* ------------------------------------------------------------------ */
/* The same clip, through the old algorithm                            */
/* ------------------------------------------------------------------ */

rule("ZUM VERGLEICH · dasselbe Video durch das bestehende Verfahren");

const LEGACY = {
  trunkIncl: { mean: 25.0, sd: 7.1, label: "Rumpfneigung (Trophy)" },
  kneeFlex: { mean: 64.5, sd: 9.7, label: "Knieflexion (Trophy)" },
  shoulderElev: { mean: 110.7, sd: 16.9, label: "Schulterelevation (Kontakt)" },
  elbowFlex: { mean: 30.1, sd: 15.9, label: "Ellbogenflexion (Kontakt)" },
};
const cam = cameraFromRig(CAMERA_RIGS.elevatedSide);
const kneeSeries = truth.frames.map((f) => f.dof.kneeFlexDeg);
const trophy = kneeSeries.indexOf(Math.max(...kneeSeries));
const at = (index: number, j: Joint) => project(cam, truth.frames[index].joints[j]).p;
const ang2 = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
  const u = { x: a.x - b.x, y: a.y - b.y };
  const w = { x: c.x - b.x, y: c.y - b.y };
  return (Math.acos(clamp((u.x * w.x + u.y * w.y) / (Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y)), -1, 1)) * 180) / Math.PI;
};
const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const angles = {
  trunkIncl: Math.abs(
    (Math.atan2(
      mid(at(trophy, "shoulderL"), at(trophy, "shoulderR")).x - mid(at(trophy, "hipL"), at(trophy, "hipR")).x,
      mid(at(trophy, "hipL"), at(trophy, "hipR")).y - mid(at(trophy, "shoulderL"), at(trophy, "shoulderR")).y,
    ) * 180) / Math.PI,
  ),
  kneeFlex: 180 - ang2(at(trophy, "hipL"), at(trophy, "kneeL"), at(trophy, "ankleL")),
  shoulderElev: ang2(at(contactIndexTruth, "hipR"), at(contactIndexTruth, "shoulderR"), at(contactIndexTruth, "elbowR")),
  elbowFlex: 180 - ang2(at(contactIndexTruth, "shoulderR"), at(contactIndexTruth, "elbowR"), at(contactIndexTruth, "wristR")),
};
console.log("  Perfekt geklickte Gelenkpunkte, richtige Schlüsselbilder, kein Trackingfehler.\n");
let total = 0;
for (const key of Object.keys(LEGACY) as Array<keyof typeof LEGACY>) {
  const r = LEGACY[key];
  const z = (angles[key] - r.mean) / r.sd;
  const score = clamp(10 * Math.exp(-(z * z) / 8), 0, 10);
  total += score;
  console.log(
    "  " + r.label.padEnd(30) +
      `${angles[key].toFixed(0).padStart(4)}°  vs. Referenz ${r.mean}° ± ${r.sd}` +
      `   →  ${score.toFixed(1)}/10`,
  );
}
console.log("\n  " + "Gesamt (ungewichteter Mittelwert)".padEnd(30) + `${(total / 4).toFixed(1)}/10`);
console.log(
  "\n  Die Knieflexion beträgt in Wahrheit " + truthKnee.toFixed(0) + "°. Aus dieser Perspektive\n" +
    "  liest das alte Verfahren " + angles.kneeFlex.toFixed(0) + "° ab — der Referenz-SD beträgt 9,7°.",
);
console.log("");
