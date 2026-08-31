/**
 * Schritt 4 — Winkel messen.
 *
 * Aus Punkten werden Gelenkwinkel. Das klingt nach der einfachsten Stelle der
 * ganzen Kette und ist die, an der die meisten Werkzeuge falsch abbiegen.
 *
 * Der übliche Fehler: den Winkel im Bild messen. Drei Punkte auf dem
 * Bildschirm, Arcuskosinus, fertig. Das ist aber nicht der Kniewinkel, sondern
 * dessen Schatten an die Wand — und der hängt davon ab, wo die Kamera stand.
 * Ein Knie, das 66° gebeugt ist, misst sich von schräg vorne als 21°. Die Zahl
 * ist nicht ungenau, sie ist eine andere Größe.
 *
 * MediaPipe liefert neben den Bildkoordinaten auch `worldLandmarks`: eine
 * Schätzung der Gelenkpositionen in Metern, relativ zur Hüftmitte, aus der
 * Perspektive der Kamera. Damit lässt sich der Winkel im Raum rechnen. Diese
 * Schätzung hat eine Schwäche — die Tiefe ist deutlich unsicherer als die
 * Bildebene —, und genau die wird hier mitgeführt statt verschwiegen:
 *
 *   `foreshortening` sagt, wie stark das Gelenk in die Tiefe zeigt. Liegt eine
 *   Gliedmaße fast auf der optischen Achse, steckt der ganze Winkel in der am
 *   schlechtesten bestimmten Richtung, und der Wert bekommt einen Vermerk.
 */

/** Die 33 Punkte, die MediaPipe liefert — nur die benannt, die wir brauchen. */
export const LM = {
  nose: 0,
  shoulderL: 11, shoulderR: 12,
  elbowL: 13, elbowR: 14,
  wristL: 15, wristR: 16,
  hipL: 23, hipR: 24,
  kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28,
  heelL: 29, heelR: 30,
  footL: 31, footR: 32,
};

/**
 * Die Winkel, die gemessen werden.
 *
 * `at` ist das Gelenk, `from` und `to` die beiden Nachbarpunkte. Der Winkel ist
 * der Innenwinkel bei `at` — 180° heißt gestreckt, 90° heißt rechtwinklig.
 * `neutral` ist die Stellung, in der die meisten Menschen stehen; sie wird
 * nirgends bewertet, sondern nur zur Achsenskalierung im Diagramm benutzt.
 */
export const JOINT_ANGLES = [
  { id: "kneeL",     label: "Knie links",      at: "kneeL",     from: "hipL",      to: "ankleL",  side: "L", neutral: 175 },
  { id: "kneeR",     label: "Knie rechts",     at: "kneeR",     from: "hipR",      to: "ankleR",  side: "R", neutral: 175 },
  { id: "hipL",      label: "Hüfte links",     at: "hipL",      from: "shoulderL", to: "kneeL",   side: "L", neutral: 175 },
  { id: "hipR",      label: "Hüfte rechts",    at: "hipR",      from: "shoulderR", to: "kneeR",   side: "R", neutral: 175 },
  { id: "elbowL",    label: "Ellbogen links",  at: "elbowL",    from: "shoulderL", to: "wristL",  side: "L", neutral: 170 },
  { id: "elbowR",    label: "Ellbogen rechts", at: "elbowR",    from: "shoulderR", to: "wristR",  side: "R", neutral: 170 },
  { id: "shoulderL", label: "Schulter links",  at: "shoulderL", from: "hipL",      to: "elbowL",  side: "L", neutral: 20 },
  { id: "shoulderR", label: "Schulter rechts", at: "shoulderR", from: "hipR",      to: "elbowR",  side: "R", neutral: 20 },
];

/** Winkel, die nicht aus drei Punkten kommen, sondern gegen eine Richtung. */
export const AXIS_ANGLES = [
  {
    id: "trunkLean",
    label: "Rumpfneigung",
    neutral: 0,
    // Gegen die Senkrechte: 0° heißt aufrecht, positive Werte heißen vorgebeugt.
    compute: (P) => {
      const sh = midpoint(P[LM.shoulderL], P[LM.shoulderR]);
      const hip = midpoint(P[LM.hipL], P[LM.hipR]);
      if (!sh || !hip) return null;
      const axis = sub(sh, hip);
      // In MediaPipes Weltkoordinaten zeigt −y nach oben.
      return angleBetween(axis, { x: 0, y: -1, z: 0 });
    },
    needs: ["shoulderL", "shoulderR", "hipL", "hipR"],
  },
];

/* ------------------------------------------------------------------ */
/* Vektorrechnung                                                      */
/* ------------------------------------------------------------------ */

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => Math.hypot(a.x, a.y, a.z);

function midpoint(a, b) {
  return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 } : null;
}

/** Winkel zwischen zwei Vektoren, in Grad. */
export function angleBetween(u, v) {
  const d = norm(u) * norm(v);
  if (d === 0) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))) * 180) / Math.PI;
}

/** Innenwinkel bei `b`, in Grad. */
export function angleAt(a, b, c) {
  if (!a || !b || !c) return null;
  return angleBetween(sub(a, b), sub(c, b));
}

/**
 * Wie stark die beiden Schenkel des Winkels in die Tiefe zeigen, als Anteil
 * zwischen 0 und 1.
 *
 * 0 heißt: beide Schenkel liegen in der Bildebene, die Kamera sieht den Winkel
 * frontal, die Tiefenschätzung spielt kaum eine Rolle. 1 heißt: ein Schenkel
 * zeigt direkt auf die Linse, und der gemessene Winkel steht und fällt mit
 * einer Zahl, die das Modell nur raten kann.
 */
export function foreshortening(a, b, c) {
  if (!a || !b || !c) return 1;
  const u = sub(a, b);
  const v = sub(c, b);
  const share = (w) => {
    const len = norm(w);
    return len === 0 ? 1 : Math.abs(w.z) / len;
  };
  return Math.max(share(u), share(v));
}

/* ------------------------------------------------------------------ */
/* Zeitreihen                                                          */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{ id:string, label:string, unit:string,
 *             t:number[], deg:(number|null)[], conf:number[],
 *             depthShare:number[] }} AngleSeries
 */

/**
 * Rechnet aus bereinigten Bildern alle Winkelverläufe.
 *
 * Jeder Wert bekommt zwei Begleitzahlen mit: `conf` ist die schwächste
 * Sichtbarkeit der beteiligten Punkte — wie sicher das Modell war, sie
 * überhaupt gesehen zu haben. `depthShare` ist die Verkürzung von oben. Beide
 * werden nicht verrechnet, sondern getrennt geführt, weil sie verschiedene
 * Dinge sind und verschieden behoben werden: schlechte Sichtbarkeit durch
 * bessere Ausleuchtung, hohe Verkürzung durch eine andere Kameraposition.
 */
export function computeAngles(frames) {
  const series = [];

  for (const def of JOINT_ANGLES) {
    const s = emptySeries(def.id, def.label, def.neutral, def.side);
    for (const frame of frames) {
      const P = frame.points;
      const a = P[LM[def.from]];
      const b = P[LM[def.at]];
      const c = P[LM[def.to]];
      s.t.push(frame.t);
      s.deg.push(angleAt(a, b, c));
      s.conf.push(Math.min(a?.v ?? 0, b?.v ?? 0, c?.v ?? 0));
      s.depthShare.push(foreshortening(a, b, c));
    }
    series.push(s);
  }

  for (const def of AXIS_ANGLES) {
    const s = emptySeries(def.id, def.label, def.neutral, null);
    for (const frame of frames) {
      const P = frame.points;
      s.t.push(frame.t);
      s.deg.push(def.compute(P));
      s.conf.push(Math.min(...def.needs.map((k) => P[LM[k]]?.v ?? 0)));
      s.depthShare.push(0);
    }
    series.push(s);
  }

  return series.map(withStats);
}

function emptySeries(id, label, neutral, side) {
  return { id, label, unit: "°", neutral, side, t: [], deg: [], conf: [], depthShare: [] };
}

/** Hängt Spannweite, Extremwerte und Abdeckung an eine Reihe. */
export function withStats(s) {
  const valid = s.deg.map((d, i) => (d === null ? null : { d, i })).filter(Boolean);
  if (!valid.length) {
    return { ...s, min: null, max: null, range: 0, coverage: 0, meanDepthShare: 1 };
  }
  let lo = valid[0];
  let hi = valid[0];
  for (const v of valid) {
    if (v.d < lo.d) lo = v;
    if (v.d > hi.d) hi = v;
  }
  const depth = s.depthShare.filter((_, i) => s.deg[i] !== null);
  return {
    ...s,
    min: { deg: lo.d, t: s.t[lo.i] },
    max: { deg: hi.d, t: s.t[hi.i] },
    range: hi.d - lo.d,
    coverage: valid.length / s.deg.length,
    meanDepthShare: depth.reduce((a, b) => a + b, 0) / depth.length,
  };
}

/** Findet die Reihe mit der größten Bewegung — der Vorschlag fürs Zählen. */
export function mostActive(series) {
  const usable = series.filter((s) => s.coverage > 0.6 && s.range > 8);
  if (!usable.length) return null;
  return usable.reduce((a, b) => (b.range > a.range ? b : a));
}
