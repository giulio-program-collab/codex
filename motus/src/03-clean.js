/**
 * Schritt 3 — Aufräumen.
 *
 * Ein Pose-Modell liefert in jedem Bild eine Schätzung, auch dann, wenn es
 * nichts Vernünftiges sieht. Ein verdecktes Knie bekommt trotzdem eine
 * Koordinate; sie springt dann von Bild zu Bild um eine halbe Beinlänge. Wer
 * daraus direkt Winkel rechnet, misst das Rauschen des Modells und nennt es
 * Biomechanik.
 *
 * Dieser Schritt macht drei Dinge, in dieser Reihenfolge:
 *
 *   1. Punkte mit zu geringer Sichtbarkeit werden zu Lücken erklärt.
 *   2. Ausreißer werden erkannt (ein Punkt, der sich schneller bewegt, als ein
 *      Körperteil kann) und ebenfalls zu Lücken erklärt.
 *   3. Kurze Lücken werden linear überbrückt, lange bleiben Lücken.
 *   4. Der Rest wird geglättet — mit Savitzky-Golay, nicht mit einem
 *      gleitenden Mittel.
 *
 * Warum Savitzky-Golay: Ein gleitendes Mittel zieht Extremwerte zur Mitte. Wir
 * messen aber genau die Extremwerte — die tiefste Kniebeugung, der schnellste
 * Punkt. Ein Boxfilter würde jede Kniebeuge flacher aussehen lassen, und zwar
 * umso mehr, je verrauschter das Video ist. Savitzky-Golay legt stattdessen in
 * jedem Fenster eine Parabel durch die Punkte und nimmt deren Wert in der
 * Mitte; Krümmung überlebt das, Rauschen nicht.
 */

/** Unter dieser Sichtbarkeit gilt ein Punkt als nicht gesehen. */
export const MIN_VISIBILITY = 0.5;

/** Lücken bis zu dieser Länge (in Bildern) werden überbrückt. */
export const MAX_GAP_FRAMES = 4;

/**
 * Eine Gliedmaße bewegt sich im Bild schneller als das, aber nicht beliebig
 * schnell. Der Wert ist in Körperhöhen pro Sekunde: ein Handgelenk erreicht
 * beim Aufschlag rund 8 m/s, das sind bei 1,8 m Körperhöhe gut 4 Körperhöhen
 * pro Sekunde. Alles darüber ist ein Sprung des Modells, keine Bewegung.
 */
export const MAX_SPEED_HEIGHTS_PER_S = 12;

/** Fensterbreite der Glättung, in Bildern. Muss ungerade sein. */
export const SMOOTH_WINDOW = 7;

/* ------------------------------------------------------------------ */
/* Eindimensionale Werkzeuge                                           */
/* ------------------------------------------------------------------ */

/**
 * Savitzky-Golay-Filter zweiter Ordnung.
 *
 * Für ein symmetrisches Fenster der Breite `w = 2m+1` und Polynomgrad 2 ist der
 * geglättete Wert in der Fenstermitte eine feste Linearkombination der
 * Fensterwerte. Die Gewichte hängen nur von `m` ab, also werden sie einmal
 * berechnet und dann wiederverwendet.
 *
 * Lücken (`null`) unterbrechen das Fenster: Es wird nur über zusammenhängende
 * Abschnitte geglättet, damit nicht über ein Loch hinweg gemittelt wird.
 */
export function savitzkyGolay(values, window = SMOOTH_WINDOW) {
  const w = Math.max(3, window % 2 === 1 ? window : window + 1);
  const m = (w - 1) / 2;
  const weights = sgWeights(m);
  const out = values.slice();

  for (const [from, to] of runsOfNumbers(values)) {
    const len = to - from;
    if (len < w) continue; // zu kurz zum Filtern, bleibt wie es ist
    for (let i = from; i < to; i++) {
      let sum = 0;
      for (let k = -m; k <= m; k++) {
        sum += weights[k + m] * sampleAt(values, from, to, i + k);
      }
      out[i] = sum;
    }
  }
  return out;
}

/**
 * Gewichte für Grad 2, aus der geschlossenen Form der Kleinste-Quadrate-Lösung:
 * c_k = 3(3m² + 3m − 1 − 5k²) / ((2m+3)(2m+1)(2m−1)).
 *
 * Für m = 2 ergibt das die klassischen Koeffizienten (−3, 12, 17, 12, −3)/35.
 */
function sgWeights(m) {
  const denom = (2 * m + 3) * (2 * m + 1) * (2 * m - 1);
  const out = [];
  for (let k = -m; k <= m; k++) {
    out.push((3 * (3 * m * m + 3 * m - 1 - 5 * k * k)) / denom);
  }
  return out;
}

/**
 * Ein Wert außerhalb des Abschnitts, durch **Punktspiegelung** am Randwert
 * fortgesetzt: v[from−d] = 2·v[from] − v[from+d].
 *
 * Die naheliegende Variante, den Verlauf einfach zu spiegeln, macht aus einer
 * ansteigenden Flanke am Rand ein V — der geglättete Randwert wird dann nach
 * oben gezogen, und zwar genau dort, wo bei einer Bewegungsaufnahme oft der
 * interessante Teil liegt. Die Punktspiegelung setzt die Steigung stattdessen
 * fort; eine Gerade überlebt sie exakt.
 */
function sampleAt(values, from, to, j) {
  if (j >= from && j < to) return values[j];
  if (j < from) {
    const mirrored = from + (from - j);
    return mirrored < to ? 2 * values[from] - values[mirrored] : values[from];
  }
  const last = to - 1;
  const mirrored = last - (j - last);
  return mirrored >= from ? 2 * values[last] - values[mirrored] : values[last];
}

/** Zusammenhängende Abschnitte aus Zahlen, als [von, bis) — `null` trennt. */
export function runsOfNumbers(values) {
  const runs = [];
  let start = null;
  for (let i = 0; i <= values.length; i++) {
    const ok = i < values.length && values[i] !== null && Number.isFinite(values[i]);
    if (ok && start === null) start = i;
    if (!ok && start !== null) {
      runs.push([start, i]);
      start = null;
    }
  }
  return runs;
}

/** Überbrückt Lücken bis `maxGap` linear; längere bleiben `null`. */
export function fillGaps(values, maxGap = MAX_GAP_FRAMES) {
  const out = values.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i] !== null) {
      i++;
      continue;
    }
    const start = i;
    while (i < out.length && out[i] === null) i++;
    const end = i; // erstes gültiges nach der Lücke
    const before = start - 1;
    // Lücken am Anfang oder am Ende haben keine zwei Stützstellen und werden
    // nicht geraten — extrapolieren hieße hier, sich etwas auszudenken.
    if (before < 0 || end >= out.length) continue;
    if (end - start > maxGap) continue;
    const a = out[before];
    const b = out[end];
    for (let j = start; j < end; j++) {
      out[j] = a + ((b - a) * (j - before)) / (end - before);
    }
  }
  return out;
}

/** Median einer Zahlenliste (ohne Lücken). */
export function median(values) {
  const xs = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/* ------------------------------------------------------------------ */
/* Die eigentliche Bereinigung                                         */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{ x:number, y:number, z:number, v:number } | null} Point
 * @typedef {{ t:number, points: Point[] }} Frame
 */

/**
 * Räumt eine Folge von Posen auf.
 *
 * `frames` sind die Rohdaten aus Schritt 2: pro Bild ein Zeitstempel in
 * Sekunden und ein Array von Punkten in Metern, relativ zur Hüftmitte
 * (MediaPipe nennt das „world landmarks"). Zurück kommen dieselben Bilder mit
 * bereinigten Punkten plus ein Protokoll, was entfernt wurde — ohne dieses
 * Protokoll ist nicht nachvollziehbar, warum ein Winkel fehlt.
 */
export function cleanTrack(frames, options = {}) {
  const minVisibility = options.minVisibility ?? MIN_VISIBILITY;
  const maxGap = options.maxGap ?? MAX_GAP_FRAMES;
  const bodyHeightM = options.bodyHeightM ?? 1.7;
  const n = frames.length;
  if (n === 0) return { frames: [], log: { dropped: 0, spikes: 0, filled: 0, byPoint: [] } };

  const count = frames[0].points.length;
  const log = { dropped: 0, spikes: 0, filled: 0, byPoint: [] };

  // Pro Körperpunkt eine eigene Zeitreihe je Koordinate. Das ist die Form, in
  // der sich Lücken und Ausreißer behandeln lassen; am Ende wird zurück in
  // Bilder umgebaut.
  const cleaned = [];
  for (let p = 0; p < count; p++) {
    const axes = { x: [], y: [], z: [] };
    const vis = [];
    for (let f = 0; f < n; f++) {
      const pt = frames[f].points[p];
      const seen = pt && pt.v >= minVisibility;
      if (!seen) log.dropped++;
      axes.x.push(seen ? pt.x : null);
      axes.y.push(seen ? pt.y : null);
      axes.z.push(seen ? pt.z : null);
      vis.push(pt ? pt.v : 0);
    }

    // Ausreißer: ein Punkt, der sich zwischen zwei Bildern weiter bewegt hat,
    // als ein Körperteil in dieser Zeit kann.
    const spikes = findSpikes(axes, frames, bodyHeightM, options.maxSpeed);
    for (const f of spikes) {
      axes.x[f] = null;
      axes.y[f] = null;
      axes.z[f] = null;
    }
    log.spikes += spikes.length;

    const beforeFill = axes.x.filter((v) => v === null).length;
    for (const a of ["x", "y", "z"]) axes[a] = fillGaps(axes[a], maxGap);
    const afterFill = axes.x.filter((v) => v === null).length;
    log.filled += beforeFill - afterFill;

    for (const a of ["x", "y", "z"]) axes[a] = savitzkyGolay(axes[a], options.window);

    cleaned.push({ axes, vis, spikes: new Set(spikes) });
    log.byPoint.push({
      index: p,
      missing: axes.x.filter((v) => v === null).length,
      spikes: spikes.length,
    });
  }

  const out = frames.map((frame, f) => ({
    t: frame.t,
    points: cleaned.map((c) =>
      c.axes.x[f] === null
        ? null
        : { x: c.axes.x[f], y: c.axes.y[f], z: c.axes.z[f], v: c.spikes.has(f) ? 0 : c.vis[f] },
    ),
  }));

  return { frames: out, log };
}

/** Bildindizes, in denen sich ein Punkt unmöglich schnell bewegt hat. */
function findSpikes(axes, frames, bodyHeightM, maxSpeedOverride) {
  const limit = (maxSpeedOverride ?? MAX_SPEED_HEIGHTS_PER_S) * bodyHeightM;
  const spikes = [];
  for (let f = 1; f < frames.length - 1; f++) {
    if (axes.x[f] === null || axes.x[f - 1] === null || axes.x[f + 1] === null) continue;
    const dtBack = frames[f].t - frames[f - 1].t;
    const dtFwd = frames[f + 1].t - frames[f].t;
    if (dtBack <= 0 || dtFwd <= 0) continue;
    const back = dist(axes, f, f - 1) / dtBack;
    const fwd = dist(axes, f, f + 1) / dtFwd;
    // Beide Seiten müssen zu schnell sein. Ein echter schneller Durchgang ist
    // auf einer Seite schnell und auf der anderen langsam; ein Ausreißer
    // springt hin und sofort wieder zurück.
    if (back > limit && fwd > limit) spikes.push(f);
  }
  return spikes;
}

function dist(axes, a, b) {
  return Math.hypot(axes.x[a] - axes.x[b], axes.y[a] - axes.y[b], axes.z[a] - axes.z[b]);
}
