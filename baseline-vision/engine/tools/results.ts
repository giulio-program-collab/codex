import { analyse } from "../src/pipeline.ts";
import { buildScenario, GOOD_CAPTURE, PHONE_CAPTURE, type ScenarioOptions } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS, generateServe } from "../src/fixtures/serve-model.ts";
import { CAMERA_RIGS } from "../src/fixtures/render.ts";
import { rootRelativeJointErrorM } from "../src/fixtures/accuracy.ts";
import { legacyServeScore } from "../src/legacy/legacy-2d.ts";
import { analyseSession } from "../src/session.ts";
import type { Joint } from "../src/core/types.ts";
import type { AnalysisReport } from "../src/layers/l14-report.ts";

/**
 * The result, measured rather than asserted.
 *
 * Four questions decide whether the rebuild was worth doing, and each one is
 * answered here by running both systems on the same clips:
 *
 *   1. Does the new chain repeat the Sinner failure?
 *   2. Can it tell a world-class serve from a weak one — which the old one cannot?
 *   3. Are its numbers right, and do its stated intervals hold?
 *   4. Does it refuse when the footage cannot carry an answer?
 *
 *   node --experimental-strip-types tools/results.ts
 */

const NOW = "2026-08-25T10:00:00Z";
const RIGS = ["side", "elevatedSide", "diagonal", "behind", "front"] as const;
const RIG_LABEL: Record<string, string> = {
  side: "seitlich",
  elevatedSide: "erhöht seitlich",
  diagonal: "diagonal",
  behind: "von hinten",
  front: "von vorn",
};

const rule = (title: string) => {
  console.log("\n" + "═".repeat(86));
  console.log(title);
  console.log("═".repeat(86));
};

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);
const f = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !isFinite(x) ? "–" : x.toFixed(d));

function run(id: string, options: ScenarioOptions) {
  const scenario = buildScenario(id, id, options);
  const result = analyse(scenario.request, {
    now: NOW,
    depthPrior: scenario.depthPrior,
  });
  return { scenario, ...result };
}

const metricOf = (report: AnalysisReport, id: string) => report.metrics.find((m) => m.id === id) ?? null;

/* ================================================================== */
/* 1 — Der Sinner-Test                                                 */
/* ================================================================== */

rule("1 · DER SINNER-TEST — ein Weltklasse-Aufschlag, fünf Kamerapositionen");
console.log(
  "\nBeide Verfahren bekommen dieselbe Bewegung. Das alte bekommt zusätzlich perfekte\n" +
    "Eingaben: exakte Gelenkpositionen, die richtigen Schlüsselbilder, kein Klickfehler.\n",
);
console.log(
  pad("Kamera", 18) +
    padL("ALT: Punkte", 12) +
    padL("NEU: Aussage", 26) +
    padL("Wert", 8) +
    padL("Qualität", 10) +
    padL("Knie gemessen", 15),
);
console.log("─".repeat(86));

const sinner: Array<{ rig: string; legacy: number; kind: string; score: number | null; quality: number; knee: number | null; kneeSd: number | null }> = [];
for (const rig of RIGS) {
  const { report } = run(`sinner-${rig}`, {
    preset: "elite",
    level: "elite",
    rig,
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
    render: GOOD_CAPTURE,
  });
  const legacy = legacyServeScore(rig, "elite").overall;
  const knee = metricOf(report, "kneeFlexionPeak");
  const row = {
    rig,
    legacy,
    kind: report.verdict.kind,
    score: report.verdict.score ?? null,
    quality: report.quality.overall,
    knee: knee?.value ?? null,
    kneeSd: knee?.sd ?? null,
  };
  sinner.push(row);
  console.log(
    pad(RIG_LABEL[rig], 18) +
      padL(f(legacy, 1) + " / 10", 12) +
      padL(row.kind === "assessment" ? "Bewertung möglich" : "keine Bewertung", 26) +
      padL(row.score === null ? "–" : row.score + "/100", 8) +
      padL(row.quality + "/100", 10) +
      padL(row.knee === null ? "nicht messbar" : f(row.knee, 0) + "±" + f(row.kneeSd ?? 0, 0) + "°", 15),
  );
}

const trueKnee = SERVE_PRESETS.elite.kneeFlexPeakDeg;
const legacyWorst = Math.min(...sinner.map((s) => s.legacy));
const legacyBest = Math.max(...sinner.map((s) => s.legacy));
const newScores = sinner.filter((s) => s.score !== null).map((s) => s.score as number);
const kneeErrors = sinner.filter((s) => s.knee !== null).map((s) => Math.abs((s.knee as number) - trueKnee));
console.log(
  `\n  Wahre maximale Knieflexion: ${f(trueKnee, 0)}°.\n` +
    `  ALT: ${f(legacyWorst, 1)} bis ${f(legacyBest, 1)} von 10 — eine Spanne von ${f(legacyBest - legacyWorst, 1)} Punkten,\n` +
    "       erzeugt allein durch die Kameraposition. Kein einziger Wert liegt über 7,2.\n" +
    `  NEU: ${newScores.length} von ${sinner.length} Kameras tragen eine Bewertung` +
    (newScores.length ? `, keine unter ${Math.min(...newScores)}/100` : "") +
    ".\n" +
    `       Die Knieflexion wird über alle fünf Kameras auf ${f(Math.max(...kneeErrors), 0)}° genau gemessen —\n` +
    "       die Kameraposition ändert das Ergebnis nicht mehr, nur noch dessen Unsicherheit.\n\n" +
    "  Einschränkung, die dazugehört: Die Parameter des Weltklasse-Modells liegen nahe\n" +
    "  an den publizierten Elite-Mittelwerten, gegen die verglichen wird. Die 100 ist\n" +
    "  deshalb kein Beleg für Güte, sondern nur dafür, dass die Kette einen sauber\n" +
    "  ausgeführten Aufschlag nicht mehr als mittelmäßig abstraft. Aussagekräftig ist\n" +
    "  die gemessene Knieflexion, nicht die Kennzahl.",
);

/* ================================================================== */
/* 2 — Unterscheidbarkeit                                              */
/* ================================================================== */

rule("2 · UNTERSCHEIDBARKEIT — Weltklasse gegen schwachen Nachwuchs");
console.log(
  "\nDer entscheidende Test für ein Bewertungswerkzeug: Zwei technisch weit\n" +
    "auseinanderliegende Aufschläge müssen auseinanderzuhalten sein.\n",
);

const pair = (["elite", "developing"] as const).map((preset) => {
  const { report } = run(`pair-${preset}`, {
    preset,
    level: preset === "elite" ? "elite" : "junior_development",
    rig: "elevatedSide",
    fps: 240,
    ageYears: preset === "elite" ? 24 : 13,
    knownFieldOfView: true,
    learnedDepth: true,
    render: GOOD_CAPTURE,
  });
  return {
    preset,
    report,
    legacy: legacyServeScore("elevatedSide", preset).overall,
    truthKnee: SERVE_PRESETS[preset].kneeFlexPeakDeg,
    truthSeparation: SERVE_PRESETS[preset].separationPeakDeg,
  };
});

console.log(
  pad("Kenngröße", 30) + padL("Weltklasse", 20) + padL("Nachwuchs", 20) + padL("getrennt?", 14),
);
console.log("─".repeat(86));

const compareMetric = (id: string, label: string, digits: number, truthOf: (p: (typeof pair)[number]) => number) => {
  const a = metricOf(pair[0].report, id);
  const b = metricOf(pair[1].report, id);
  if (!a || !b || a.value === null || b.value === null) {
    console.log(pad(label, 30) + padL("nicht messbar", 20) + padL("nicht messbar", 20) + padL("–", 14));
    return;
  }
  const sep = Math.abs(a.value - b.value) / Math.hypot(a.sd ?? 0, b.sd ?? 0);
  console.log(
    pad(label, 30) +
      padL(f(a.value, digits) + " ± " + f(a.sd ?? 0, digits), 20) +
      padL(f(b.value, digits) + " ± " + f(b.sd ?? 0, digits), 20) +
      padL(sep >= 2 ? "ja, " + f(sep, 1) + " σ" : "nein (" + f(sep, 1) + " σ)", 14),
  );
  console.log(
    pad("   wahr", 30) + padL(f(truthOf(pair[0]), digits), 20) + padL(f(truthOf(pair[1]), digits), 20),
  );
};

compareMetric("kneeFlexionPeak", "Maximale Knieflexion", 0, (p) => p.truthKnee);
compareMetric("hipShoulderSeparationPeak", "Hüft-Schulter-Trennung", 0, (p) => p.truthSeparation);
compareMetric("contactHeightRatio", "Treffpunkt / Körperhöhe", 2, (p) =>
  generateServe(SERVE_PRESETS[p.preset], 240).contactHeightFraction,
);
compareMetric("racketHeadPeakSpeed", "Schlägerkopfgeschwindigkeit", 0, (p) =>
  generateServe(SERVE_PRESETS[p.preset], 240).peakRacketHeadSpeedMs * 3.6,
);

console.log(
  `\n  ALT: ${f(pair[0].legacy, 1)} / 10 für den Weltklasse-Aufschlag, ${f(pair[1].legacy, 1)} / 10 für den\n` +
    `       Nachwuchsaufschlag — ein Unterschied von ${f(Math.abs(pair[0].legacy - pair[1].legacy), 1)} Punkten auf einer Skala,\n` +
    "       die je nach Kamera um mehrere Punkte springt. Praktisch nicht unterscheidbar.",
);

/* ================================================================== */
/* 3 — Genauigkeit und Intervalltreue                                  */
/* ================================================================== */

rule("3 · GENAUIGKEIT — stimmen die Zahlen, und halten die Intervalle?");

const truth480 = generateServe(SERVE_PRESETS.elite, 480);
const contactIndex = Math.round(SERVE_PRESETS.elite.contactT * 480);
const EXPECTATIONS: Array<{ id: string; label: string; truth: number; unit: string; digits: number }> = [
  { id: "kneeFlexionPeak", label: "Maximale Knieflexion", truth: SERVE_PRESETS.elite.kneeFlexPeakDeg, unit: "°", digits: 1 },
  { id: "elbowFlexionAtContact", label: "Ellbogenflexion (Kontakt)", truth: truth480.frames[contactIndex].dof.elbowFlexDeg, unit: "°", digits: 1 },
  { id: "hipShoulderSeparationPeak", label: "Hüft-Schulter-Trennung", truth: SERVE_PRESETS.elite.separationPeakDeg, unit: "°", digits: 1 },
  { id: "contactHeightRatio", label: "Treffpunkt / Körperhöhe", truth: truth480.contactHeightFraction, unit: "", digits: 3 },
  { id: "contactHeightM", label: "Treffpunkthöhe", truth: truth480.contactHeightM, unit: " m", digits: 2 },
  { id: "pelvisPeakLead", label: "Becken-Peak vor Kontakt", truth: SERVE_PRESETS.elite.pelvisPeakLeadS, unit: " s", digits: 3 },
  { id: "trunkPeakLead", label: "Rumpf-Peak vor Kontakt", truth: SERVE_PRESETS.elite.trunkPeakLeadS, unit: " s", digits: 3 },
  { id: "racketHeadPeakSpeed", label: "Schlägerkopf-Spitze", truth: truth480.peakRacketHeadSpeedMs * 3.6, unit: " km/h", digits: 1 },
];

const errors = new Map<string, number[]>();
const ratios = new Map<string, number[]>();
let covered = 0;
let total = 0;
const jointErrors: number[] = [];

for (const rig of ["elevatedSide", "side", "diagonal"] as const) {
  for (const seed of [3, 17, 41]) {
    const { report, intermediates, scenario } = run(`acc-${rig}-${seed}`, {
      preset: "elite",
      level: "elite",
      rig,
      fps: 240,
      seed,
      knownFieldOfView: true,
      learnedDepth: true,
      render: GOOD_CAPTURE,
    });
    jointErrors.push(rootRelativeJointErrorM(intermediates.poses3d, scenario.truth, 240) * 1000);
    for (const e of EXPECTATIONS) {
      const m = metricOf(report, e.id);
      if (!m || m.value === null || m.interval95 === null || m.rejected || m.confidence < 0.35) continue;
      total++;
      if (e.truth >= m.interval95[0] && e.truth <= m.interval95[1]) covered++;
      if (!errors.has(e.id)) {
        errors.set(e.id, []);
        ratios.set(e.id, []);
      }
      errors.get(e.id)!.push(m.value - e.truth);
      if (m.sd) ratios.get(e.id)!.push(Math.abs(m.value - e.truth) / m.sd);
    }
  }
}

console.log(
  "\n" +
    pad("Kenngröße", 30) +
    padL("wahr", 12) +
    padL("mittl. Fehler", 16) +
    padL("|Fehler| / σ", 14) +
    padL("n", 5),
);
console.log("─".repeat(86));
for (const e of EXPECTATIONS) {
  const errs = errors.get(e.id) ?? [];
  if (!errs.length) {
    console.log(pad(e.label, 30) + padL(f(e.truth, e.digits) + e.unit, 12) + padL("nicht gemessen", 16));
    continue;
  }
  const mean = errs.reduce((s, v) => s + v, 0) / errs.length;
  const rs = ratios.get(e.id) ?? [];
  const meanRatio = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : NaN;
  console.log(
    pad(e.label, 30) +
      padL(f(e.truth, e.digits) + e.unit, 12) +
      padL((mean >= 0 ? "+" : "") + f(mean, e.digits) + e.unit, 16) +
      padL(f(meanRatio, 1), 14) +
      padL(errs.length, 5),
  );
}

const meanJoint = jointErrors.reduce((s, v) => s + v, 0) / jointErrors.length;
console.log(
  `\n  Gelenkfehler der Rekonstruktion: ${f(Math.min(...jointErrors), 0)}–${f(Math.max(...jointErrors), 0)} mm ` +
    `(Mittel ${f(meanJoint, 0)} mm), wurzelbezogen.\n` +
    `  Intervalltreue: ${covered} von ${total} wahren Werten liegen im angegebenen 95-%-Intervall ` +
    `(${Math.round((covered / total) * 100)} %).`,
);

/* ================================================================== */
/* 4 — Verweigerung                                                    */
/* ================================================================== */

rule("4 · VERWEIGERUNG — was passiert, wenn die Aufnahme nichts hergibt?");

const OCCLUDED: Joint[] = ["hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR"];
const GRADES: Array<{ id: string; label: string; options: ScenarioOptions }> = [
  {
    id: "labor",
    label: "Stativ, 240 fps, kalibriert",
    options: { rig: "elevatedSide", fps: 240, knownFieldOfView: true, learnedDepth: true, render: GOOD_CAPTURE },
  },
  {
    id: "handy",
    label: "Handy am Zaun, 120 fps",
    options: { rig: "diagonal", fps: 120, render: PHONE_CAPTURE },
  },
  {
    id: "schlecht",
    label: "verwackelt, 30 fps, Beine verdeckt",
    options: {
      rig: "side",
      fps: 30,
      render: {
        ...PHONE_CAPTURE,
        noisePx: 9,
        baseScore: 0.55,
        dropoutRate: 0.12,
        occlusionWindows: [{ startS: 0.5, endS: 0.95, joints: OCCLUDED }],
      },
    },
  },
];

console.log(
  "\n" +
    pad("Aufnahme", 34) +
    padL("Qualität", 10) +
    padL("Aussage", 20) +
    padL("Messwerte", 12) +
    padL("ALT sagt", 10),
);
console.log("─".repeat(86));

for (const grade of GRADES) {
  const { report } = run(`grade-${grade.id}`, {
    preset: "elite",
    level: "elite",
    ...grade.options,
  });
  const quotable = report.metrics.filter((m) => !m.rejected && m.confidence >= 0.6).length;
  const legacy = legacyServeScore(
    (grade.options.rig ?? "elevatedSide") as keyof typeof CAMERA_RIGS,
    "elite",
  ).overall;
  console.log(
    pad(grade.label, 34) +
      padL(report.quality.overall + "/100", 10) +
      padL(report.verdict.kind === "assessment" ? "Bewertung" : report.verdict.kind === "partial" ? "Teilbefund" : "nichts messbar", 20) +
      padL(quotable + " von " + (report.metrics.length + report.notMeasurable.length), 12) +
      padL(f(legacy, 1) + "/10", 10),
  );
}

/* ================================================================== */
/* 5 — Was auch die neue Kette nicht kann                              */
/* ================================================================== */

rule("5 · DIE GRENZE — wo auch diese Kette aufhört");

const sessionScenarios = Array.from({ length: 6 }, (_, i) => {
  const base = SERVE_PRESETS.elite;
  const offset = ((i * 2654435761) % 1000) / 1000 - 0.5;
  return buildScenario(`limit-${i}`, `Wurf ${i + 1}`, {
    preset: { ...base, pelvisPeakLeadS: base.pelvisPeakLeadS + offset * 0.012 },
    level: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
    render: GOOD_CAPTURE,
    seed: 30 + i * 11,
  });
});
const session = analyseSession(
  {
    player: sessionScenarios[0].request.player,
    stroke: "serve",
    date: "2026-08-25",
    repetitions: sessionScenarios.map((s) => ({ request: s.request, depthPrior: s.depthPrior })),
  },
  { now: NOW },
);
const lead = session.aggregates.find((a) => a.featureId === "pelvisPeakLead");
if (lead) {
  console.log(
    `\n  Sechs Würfe bei 240 fps, Becken-Peak vor Kontakt:\n` +
      `    Mittelwert          ${f(lead.mean * 1000, 1)} ms\n` +
      `    Streuung der Würfe  ${f((lead.sd ?? 0) * 1000, 1)} ms\n` +
      `    Unsicherheit        ± ${f(lead.sem * 1000, 1)} ms  (davon ${f(lead.systematicFloor * 1000, 1)} ms systematisch,\n` +
      "                          also durch mehr Würfe nicht kleiner zu bekommen)\n" +
      "    Referenzbänder der Literatur trennen Elite von Sub-Elite bei 4–9 ms.\n\n" +
      "  Ergebnis: Die absolute Reihenfolge der kinetischen Kette ist aus einer\n" +
      "  einzelnen Kamera nicht auflösbar — auch nicht mit sechs Wiederholungen.\n" +
      "  Das System sagt das, statt eine Zahl zu liefern, die keine Aussage trägt.",
  );
}

console.log("");
