import test from "node:test";
import assert from "node:assert/strict";

import { savitzkyGolay, fillGaps, cleanTrack, runsOfNumbers } from "../src/03-clean.js";
import { angleAt, foreshortening, computeAngles, withStats, LM } from "../src/04-angles.js";
import { findRepetitions, findPeaks } from "../src/05-reps.js";
import { buildReport, slope, sd, seriesToCsv, trend, jitterShare } from "../src/06-report.js";

/* ------------------------------------------------------------------ */
/* Ein Prüfstand: eine Bewegung, deren Antwort wir kennen               */
/* ------------------------------------------------------------------ */

/**
 * Baut eine Kniebeuge-Serie: `count` Wiederholungen, jede von `top` Grad auf
 * `bottom` Grad und zurück, mit `hz` Bildern pro Sekunde. Optional mit Rauschen
 * und mit Lücken, damit die Bereinigung etwas zu tun bekommt.
 */
function squatSignal({ count = 5, top = 172, bottom = 78, period = 2.0, hz = 30, noise = 0, seed = 7 }) {
  const rng = mulberry(seed);
  const t = [];
  const deg = [];
  const total = count * period;
  for (let s = 0; s <= total * hz; s++) {
    const time = s / hz;
    // Ein voller Zyklus pro `period`: oben, runter, oben.
    const phase = (time % period) / period;
    const shape = (1 - Math.cos(2 * Math.PI * phase)) / 2; // 0 oben, 1 unten
    t.push(time);
    deg.push(top - (top - bottom) * shape + (noise ? (rng() - 0.5) * 2 * noise : 0));
  }
  return { id: "kneeL", label: "Knie links", unit: "°", t, deg, conf: deg.map(() => 0.95), depthShare: deg.map(() => 0.1) };
}

function mulberry(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Schritt 3 — Aufräumen                                               */
/* ------------------------------------------------------------------ */

test("Glättung verschiebt den Extremwert nicht, ein gleitendes Mittel schon", () => {
  // Der Grund für Savitzky-Golay statt Boxfilter, als Test formuliert. Geprüft
  // wird die *Verzerrung*, also ohne Rauschen: Was macht der Filter mit der
  // Krümmung an der tiefsten Stelle der Kniebeuge?
  const clean = squatSignal({ count: 1, period: 1.2, hz: 60, noise: 0 });
  const trueMin = Math.min(...clean.deg);

  const sgError = Math.abs(Math.min(...savitzkyGolay(clean.deg, 15)) - trueMin);
  const boxError = Math.abs(Math.min(...boxFilter(clean.deg, 15)) - trueMin);

  assert.ok(boxError > 1.5, `der Boxfilter müsste hier flachziehen, tut es aber nur um ${boxError.toFixed(2)}°`);
  assert.ok(
    sgError < boxError / 4,
    `Savitzky-Golay ${sgError.toFixed(2)}° gegen Boxfilter ${boxError.toFixed(2)}°`,
  );
});

test("Glättung dämpft Rauschen so stark, wie die Filtertheorie es zulässt", () => {
  // Die andere Hälfte: Verzerrungsfreiheit wäre wertlos, wenn dabei nichts
  // geglättet würde.
  //
  // Gemessen wird an *reinem* Rauschen, ohne Signal darunter. Das ist wichtig:
  // An einem echten Verlauf mischt sich in jeden Fehler auch die Verzerrung
  // des Filters, und man weiß hinterher nicht, welcher Anteil woher kam. Ohne
  // Signal ist die Frage sauber, und die Antwort steht fest — die Dämpfung
  // eines linearen Filters ist 1/√(Σ c_k²) über seine Gewichte. Für Grad 2 und
  // neun Punkte, Gewichte (−21, 14, 39, 54, 59, 54, 39, 14, −21)/231, sind das
  // 1,98. Wer mehr erreicht, glättet nicht, sondern verliert Signal.
  const rng = mulberry(11);
  const noise = Array.from({ length: 4000 }, () => (rng() - 0.5) * 2 * 3);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

  const weights = [-21, 14, 39, 54, 59, 54, 39, 14, -21].map((c) => c / 231);
  const theory = 1 / Math.sqrt(weights.reduce((a, c) => a + c * c, 0));
  const measured = rms(noise) / rms(savitzkyGolay(noise, 9));

  assert.ok(Math.abs(theory - 1.98) < 0.02, `Theorie: ${theory.toFixed(3)}`);
  assert.ok(
    Math.abs(measured - theory) < 0.15,
    `gedämpft um Faktor ${measured.toFixed(2)}, theoretisch ${theory.toFixed(2)}`,
  );
});

test("an einem echten Verlauf bleibt neben dem Rauschen etwas Verzerrung übrig", () => {
  // Der ehrliche Gegenpol zum Test darüber: Auf einem gekrümmten Signal
  // erreicht der Filter seine theoretische Dämpfung *nicht*, weil er zugleich
  // die Krümmung leicht abflacht. Diese Lücke ist kein Fehler, sie ist der
  // Preis jeder Glättung — und sie gehört in einen Test, damit niemand später
  // die theoretische Zahl für die erreichte hält.
  const clean = squatSignal({ count: 2, period: 1.5, hz: 60, noise: 0 });
  const noisy = squatSignal({ count: 2, period: 1.5, hz: 60, noise: 3 });
  const rms = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);
  const gain = rms(noisy.deg, clean.deg) / rms(savitzkyGolay(noisy.deg, 9), clean.deg);
  assert.ok(gain > 1.5, `nur um Faktor ${gain.toFixed(2)} verbessert`);
  assert.ok(gain < 1.98, `Faktor ${gain.toFixed(2)} kann auf einem gekrümmten Signal nicht stimmen`);
});

function boxFilter(values, w) {
  const m = (w - 1) / 2;
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = -m; k <= m; k++) {
      const j = Math.max(0, Math.min(values.length - 1, i + k));
      sum += values[j];
      n++;
    }
    return sum / n;
  });
}

test("Glättung ist wertetreu, wo nichts zu glätten ist", () => {
  const line = Array.from({ length: 40 }, (_, i) => 2 * i + 5);
  const out = savitzkyGolay(line, 7);
  // Eine Gerade ist ein Polynom zweiten Grades; sie muss exakt überleben.
  for (let i = 0; i < line.length; i++) {
    assert.ok(Math.abs(out[i] - line[i]) < 1e-6, `Index ${i}: ${out[i]} statt ${line[i]}`);
  }
});

test("kurze Lücken werden überbrückt, lange bleiben Lücken", () => {
  const v = [10, null, null, 16, null, null, null, null, null, null, 30];
  const out = fillGaps(v, 4);
  assert.equal(out[1], 12);
  assert.equal(out[2], 14);
  assert.equal(out[4], null, "eine Lücke von sechs Bildern darf nicht geraten werden");
  assert.equal(out[9], null);
});

test("Lücken am Rand werden nicht extrapoliert", () => {
  const out = fillGaps([null, null, 5, 6, 7, null], 4);
  assert.equal(out[0], null);
  assert.equal(out[5], null);
});

test("runsOfNumbers trennt an Lücken", () => {
  assert.deepEqual(runsOfNumbers([1, 2, null, 4, 5, 6]), [[0, 2], [3, 6]]);
});

test("ein Sprung, der schneller ist als ein Körperteil, wird verworfen", () => {
  // Ein ruhendes Handgelenk, das in einem einzigen Bild einen Meter springt.
  const n = 20;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const jump = i === 10 ? 1.0 : 0;
    const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, v: 0.9 }));
    points[LM.wristL] = { x: jump, y: 0, z: 0, v: 0.9 };
    frames.push({ t: i / 30, points });
  }
  const { frames: out, log } = cleanTrack(frames, { bodyHeightM: 1.8 });
  assert.equal(log.spikes, 1, "der Sprung wurde nicht als Ausreißer erkannt");
  // Nach dem Verwerfen wird die Lücke überbrückt — der Punkt liegt wieder nahe null.
  assert.ok(Math.abs(out[10].points[LM.wristL].x) < 0.05);
});

/* ------------------------------------------------------------------ */
/* Schritt 4 — Winkel                                                  */
/* ------------------------------------------------------------------ */

test("angleAt misst den Innenwinkel", () => {
  const a = { x: 1, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  const c = { x: 0, y: 1, z: 0 };
  assert.ok(Math.abs(angleAt(a, b, c) - 90) < 1e-9);
  assert.ok(Math.abs(angleAt(a, b, { x: -1, y: 0, z: 0 }) - 180) < 1e-9);
});

test("ein Winkel im Bild ist nicht der Winkel im Raum", () => {
  // Genau der Fehler, den Schritt 4 vermeidet. Ein Knie, exakt 60° gebeugt.
  // Der Oberschenkel liegt in der Bildebene, der Unterschenkel wird um die
  // Oberschenkelachse gedreht — der Winkel im Raum ändert sich dabei nie.
  const hip = { x: 0, y: 1, z: 0 };
  const knee = { x: 0, y: 0, z: 0 };
  const shank = (phi) => ({
    x: Math.sin((60 * Math.PI) / 180) * Math.cos(phi),
    y: Math.cos((60 * Math.PI) / 180),
    z: Math.sin((60 * Math.PI) / 180) * Math.sin(phi),
  });
  const flat = angleAt(hip, knee, shank(0));
  const swung = angleAt(hip, knee, shank(Math.PI / 2));
  assert.ok(Math.abs(flat - 60) < 1e-6, `${flat}`);
  assert.ok(Math.abs(swung - 60) < 1e-6, `im Raum bleiben es 60°, gemessen: ${swung}`);

  // Dieselben Punkte, aber die Tiefe weggeworfen — so misst ein 2D-Werkzeug.
  const projected = (a, b, c) => angleAt({ ...a, z: 0 }, { ...b, z: 0 }, { ...c, z: 0 });
  assert.ok(Math.abs(projected(hip, knee, shank(0)) - 60) < 1e-6);
  const collapsed = projected(hip, knee, shank(Math.PI / 2));
  assert.ok(collapsed < 1e-6, `aus 60° im Raum werden im Bild ${collapsed.toFixed(1)}°`);
});

test("Verkürzung erkennt, wenn ein Schenkel auf die Kamera zeigt", () => {
  const inPlane = foreshortening({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const towards = foreshortening({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  assert.ok(inPlane < 0.01, `in der Bildebene: ${inPlane}`);
  assert.ok(towards > 0.99, `auf die Kamera zu: ${towards}`);
});

test("computeAngles liefert für jedes Gelenk eine vollständige Reihe", () => {
  const frames = syntheticSquatFrames(60);
  const series = computeAngles(frames);
  const knee = series.find((s) => s.id === "kneeL");
  assert.ok(knee, "kein Kniewinkel berechnet");
  assert.equal(knee.deg.length, frames.length);
  assert.equal(knee.coverage, 1);
  assert.ok(knee.range > 50, `Kniebeuge mit nur ${knee.range.toFixed(0)}° Spannweite`);
});

/** Ein Bein, das sich beugt: Hüfte fest, Knie fest, Knöchel schwingt. */
function syntheticSquatFrames(n) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const phase = (i / n) * 2 * Math.PI;
    const bend = (1 - Math.cos(phase)) / 2; // 0 gestreckt, 1 gebeugt
    const angle = (Math.PI / 180) * (175 - 95 * bend);
    const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, v: 0.95 }));
    points[LM.hipL] = { x: 0, y: 0, z: 0, v: 0.95 };
    points[LM.kneeL] = { x: 0, y: 0.45, z: 0, v: 0.95 };
    points[LM.ankleL] = {
      x: 0.45 * Math.sin(Math.PI - angle),
      y: 0.45 + 0.45 * Math.cos(Math.PI - angle),
      z: 0,
      v: 0.95,
    };
    frames.push({ t: i / 30, points });
  }
  return frames;
}

/* ------------------------------------------------------------------ */
/* Schritt 5 — Wiederholungen                                          */
/* ------------------------------------------------------------------ */

test("fünf Kniebeugen werden als fünf gezählt", () => {
  const s = withStats(squatSignal({ count: 5, period: 2.0, hz: 30, noise: 1.5 }));
  const { reps, direction } = findRepetitions(s);
  assert.equal(reps.length, 5, `gezählt: ${reps.length}`);
  assert.equal(direction, "down", "eine Kniebeuge ist eine Bewegung nach unten");
  for (const r of reps) {
    assert.ok(Math.abs(r.duration - 2.0) < 0.35, `Wiederholung ${r.index} dauert ${r.duration.toFixed(2)} s`);
    assert.ok(r.extreme < 95, `tiefster Punkt bei ${r.extreme.toFixed(0)}°`);
  }
});

test("Zählen funktioniert, wenn die Bewegung im Verlauf flacher wird", () => {
  // Der Fall, an dem jede feste Schwelle scheitert: Die erste Wiederholung geht
  // auf 78°, die letzte nur noch auf 104°. Eine Schwelle bei 90° würde die
  // Hälfte verlieren.
  const base = squatSignal({ count: 6, period: 1.6, hz: 30 });
  const deg = base.deg.map((d, i) => {
    const fade = (i / base.deg.length) * 26;
    return d + (172 - d) * 0 + fade * ((172 - d) / 94);
  });
  const s = withStats({ ...base, deg });
  const { reps } = findRepetitions(s);
  assert.equal(reps.length, 6, `gezählt: ${reps.length}`);
  assert.ok(reps[0].extreme < reps[5].extreme, "die Ermüdung ist im Ergebnis nicht sichtbar");
});

test("eine Bewegung nach oben wird als solche erkannt", () => {
  const down = squatSignal({ count: 4, period: 1.5, hz: 30 });
  const up = withStats({ ...down, deg: down.deg.map((d) => 250 - d) });
  const { reps, direction } = findRepetitions(up);
  assert.equal(direction, "up");
  assert.equal(reps.length, 4);
});

test("Rauschen erzeugt keine Wiederholungen", () => {
  const rng = mulberry(3);
  const t = Array.from({ length: 300 }, (_, i) => i / 30);
  const deg = t.map(() => 170 + (rng() - 0.5) * 6);
  const { reps } = findRepetitions(withStats({ id: "x", label: "x", unit: "°", t, deg, conf: t.map(() => 0.9), depthShare: t.map(() => 0.1) }));
  assert.equal(reps.length, 0, `aus Rauschen wurden ${reps.length} Wiederholungen`);
});

test("Prominenz ignoriert die Höhe des Tals, nicht seine Tiefe", () => {
  //            klein        groß                klein
  const y = [0, 1, 0, 5, 0, 1, 0, 10, 0, 1, 0];
  const t = y.map((_, i) => i / 30);
  const peaks = findPeaks(y, t, 4, 0);
  assert.deepEqual(peaks.map((p) => p.i), [3, 7], "nur die beiden hohen Gipfel zählen");
});

/* ------------------------------------------------------------------ */
/* Schritt 6 — Bericht                                                 */
/* ------------------------------------------------------------------ */

test("der Bericht zählt, misst und rechnet den Trend", () => {
  const s = withStats(squatSignal({ count: 5, period: 2.0, hz: 30, noise: 1 }));
  const repResult = findRepetitions(s);
  const report = buildReport([s], repResult, { fps: 30, duration: 10, frameCount: s.t.length });

  assert.equal(report.reps.count, 5);
  assert.ok(Math.abs(report.reps.meanDuration - 2.0) < 0.3);
  const knee = report.joints[0];
  assert.ok(knee.min < 85 && knee.max > 165, `${knee.min}–${knee.max}°`);
  assert.equal(knee.perRep.length, 5);
  assert.equal(knee.reliable, true);
});

test("ein Trend über die Wiederholungen wird als solcher ausgewiesen", () => {
  const base = squatSignal({ count: 6, period: 1.6, hz: 30 });
  const deg = base.deg.map((d, i) => d + ((i / base.deg.length) * 26 * (172 - d)) / 94);
  const s = withStats({ ...base, deg });
  const report = buildReport([s], findRepetitions(s), { fps: 30, duration: 10, frameCount: s.t.length });
  const knee = report.joints[0];
  assert.ok(knee.consistency, "keine Konsistenzangabe");
  assert.ok(knee.consistency.driftPerRep < -1, `Trend ${knee.consistency.driftPerRep}°/Wdh.`);
  assert.equal(knee.consistency.driftIsReal, true);
});

test("ein lückenhaftes Gelenk wird als unzuverlässig markiert und begründet", () => {
  const s = withStats(squatSignal({ count: 3, hz: 30 }));
  // Die Hälfte der Bilder fehlt.
  const holed = withStats({ ...s, deg: s.deg.map((d, i) => (i % 2 ? null : d)) });
  const report = buildReport([holed], { reps: [], direction: "down" }, { fps: 30, duration: 6, frameCount: s.t.length });
  assert.equal(report.joints[0].reliable, false);
  assert.ok(report.caveats.some((c) => c.id === "coverage"), "kein Hinweis auf die Lücken");
  assert.ok(report.caveats.every((c) => c.remedy && c.remedy.length > 10), "ein Hinweis ohne Abhilfe");
});

test("eine niedrige Bildrate wird benannt, nicht verschwiegen", () => {
  const s = withStats(squatSignal({ count: 3, hz: 15 }));
  const report = buildReport([s], findRepetitions(s), { fps: 15, duration: 6, frameCount: s.t.length });
  assert.ok(report.caveats.some((c) => c.id === "framerate"));
});

test("CSV enthält jede Zeile und jede Reihe", () => {
  const s = withStats(squatSignal({ count: 1, period: 1, hz: 10 }));
  const csv = seriesToCsv([s]);
  const lines = csv.split("\n");
  assert.equal(lines.length, s.t.length + 1);
  assert.equal(lines[0], "t_s,kneeL_deg,kneeL_conf");
});

test("Statistik: Steigung und Streuung", () => {
  assert.ok(Math.abs(slope([1, 2, 3, 4, 5]) - 1) < 1e-9);
  assert.ok(Math.abs(slope([5, 5, 5]) - 0) < 1e-9);
  assert.ok(Math.abs(sd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.01);
});

test("ein perfekt gerader Trend gilt als Trend, nicht als Nichts", () => {
  // Der Sonderfall, an dem sich ein t-Wert leicht selbst austrickst: Ohne
  // Streuung um die Gerade ist der Standardfehler null, und der Quotient
  // Steigung/Fehler nicht definiert. Wer dann 0 zurückgibt, verschweigt
  // ausgerechnet den saubersten denkbaren Verlauf.
  const perfect = trend([100, 90, 80, 70, 60]);
  assert.equal(perfect.significant, true, `t = ${perfect.t}`);
  assert.ok(Math.abs(perfect.slope + 10) < 1e-9);

  // Und die Gegenprobe: eine waagerechte Gerade hat keine Steigung.
  assert.equal(trend([70, 70, 70, 70, 70]).significant, false);
});

test("aus drei Wiederholungen wird kein Trend gemeldet", () => {
  // Durch drei Punkte lässt sich immer eine Gerade legen, und sie hat immer
  // eine Steigung. Das ist keine Beobachtung.
  assert.equal(trend([100, 60, 20]).significant, false);
  assert.equal(trend([100, 60, 20]).se, null);
});

test("verrauschte Wiederholungen ergeben trotz Steigung keinen Trend", () => {
  const noisy = trend([80, 40, 90, 30, 85, 35]);
  assert.ok(Math.abs(noisy.t) < 2, `t = ${noisy.t.toFixed(2)}`);
  assert.equal(noisy.significant, false);
});

test("eine abgerissene Verfolgung wird erkannt, obwohl alles sichtbar aussieht", () => {
  // Der Fall, den Sichtbarkeit und Abdeckung nicht fangen: Das Modell ist sich
  // sicher — und verfolgt die falsche Person. Die Winkel springen dann zwischen
  // zwei Bildern hin und im nächsten zurück.
  const s = withStats(squatSignal({ count: 3, period: 1.5, hz: 60 }));
  const broken = s.deg.slice();
  for (let i = 200; i < 230; i += 2) broken[i] = broken[i] + 80;
  const jumpy = withStats({ ...s, deg: broken });

  assert.ok(jitterShare(s) < 0.001, `saubere Reihe: ${jitterShare(s)}`);
  assert.ok(jitterShare(jumpy) > 0.02, `zappelnde Reihe: ${jitterShare(jumpy)}`);

  const report = buildReport([jumpy], findRepetitions(jumpy), { fps: 60, duration: 4.5, frameCount: s.t.length });
  assert.equal(report.joints[0].reliable, false);
  const caveat = report.caveats.find((c) => c.id === "tracking");
  assert.ok(caveat, "kein Hinweis auf die abgerissene Verfolgung");
  assert.ok(caveat.remedy.length > 20);
});
