/**
 * Schritt 6 — Zusammenfassen.
 *
 * Bis hierher sind es Zahlen pro Bild. Was ein Mensch davon braucht, sind vier
 * Auskünfte, und MOTUS gibt nur diese vier:
 *
 *   1. Was war die Bewegung? — Spannweite und Extremwerte je Gelenk.
 *   2. Wie oft, wie lange? — Wiederholungen mit Dauer und Tiefe.
 *   3. Bleibt es gleich? — Streuung über die Wiederholungen, und ob es
 *      im Verlauf abfällt.
 *   4. Ist links wie rechts? — Seitenvergleich, wo beide Seiten messbar sind.
 *
 * Und eine fünfte Auskunft, die keine Kennzahl ist: **worauf man sich hier
 * nicht verlassen sollte.** Jede Reihe trägt ihre Abdeckung und ihre Verkürzung
 * mit; wo eine davon schlecht ist, sagt der Bericht das an der Zahl selbst,
 * statt sie kommentarlos neben die guten zu stellen.
 *
 * Was MOTUS ausdrücklich *nicht* tut: benoten. Es gibt keine Punktzahl und
 * keinen Vergleich mit einer Referenzgruppe. Ob 92° Kniebeugung gut sind, hängt
 * von der Übung, vom Körperbau und von der Absicht ab — das weiß der Mensch vor
 * dem Bildschirm und nicht das Programm.
 */

/** Unter dieser Abdeckung wird eine Reihe als lückenhaft ausgewiesen. */
export const LOW_COVERAGE = 0.7;

/** Ab diesem Tiefenanteil ist ein Winkel perspektivisch heikel. */
export const HIGH_DEPTH_SHARE = 0.6;

/** Unter dieser Sichtbarkeit im Mittel gilt ein Gelenk als schlecht gesehen. */
export const LOW_CONFIDENCE = 0.6;

/**
 * Ab diesem Anteil zappelnder Bilder gilt die Verfolgung als instabil.
 *
 * Der schwierigste Fehlerfall ist nicht das verdeckte Gelenk — das meldet sich
 * über die Sichtbarkeit. Es ist das Gelenk, das *falsch* verfolgt wird, während
 * das Modell sich sicher ist: Die Person läuft aus dem Bild, das Modell greift
 * sich jemanden im Hintergrund, und die Winkel schlagen zwischen zwei Bildern
 * um hundert Grad aus und wieder zurück. Abdeckung und Sichtbarkeit sehen dabei
 * tadellos aus.
 *
 * Erkennen lässt sich das an der Physik: Ein Gelenk kann schnell sein, aber es
 * kann nicht in einem Bild vor und im nächsten zurück. Gezählt werden deshalb
 * Richtungswechsel, die auf beiden Seiten schneller sind als menschlich möglich.
 */
export const JITTER_LIMIT = 0.02;

/** Über dieser Winkelgeschwindigkeit bewegt sich kein Gelenk hin und zurück. */
export const IMPOSSIBLE_DEG_PER_S = 900;

/**
 * Baut den Bericht.
 *
 * @param {Array} series      Winkelverläufe aus Schritt 4
 * @param {Object} repResult  Ergebnis aus Schritt 5
 * @param {Object} meta       { fps, duration, frameCount, sourceName }
 */
export function buildReport(series, repResult, meta) {
  const joints = series.map((s) => describeJoint(s, repResult));
  const reps = describeReps(series, repResult);
  const symmetry = describeSymmetry(series);
  const caveats = collectCaveats(joints, meta);

  return {
    tool: "MOTUS",
    version: 1,
    generatedAt: new Date().toISOString(),
    source: meta.sourceName ?? null,
    video: {
      duration: meta.duration ?? null,
      analysedFrames: meta.frameCount ?? null,
      sampleHz: meta.fps ?? null,
    },
    countedOn: repResult.reps.length ? repResult.seriesId ?? null : null,
    joints,
    reps,
    symmetry,
    caveats,
  };
}

/* ------------------------------------------------------------------ */
/* Gelenke                                                             */
/* ------------------------------------------------------------------ */

function describeJoint(s, repResult) {
  const perRep = (repResult.reps ?? []).map((r) => extremesIn(s, r.startFrame, r.endFrame));
  const extremes = perRep.filter((e) => e.min !== null);

  return {
    id: s.id,
    label: s.label,
    unit: s.unit,
    min: s.min ? round(s.min.deg) : null,
    max: s.max ? round(s.max.deg) : null,
    range: round(s.range),
    tOfMin: s.min ? round(s.min.t, 3) : null,
    tOfMax: s.max ? round(s.max.t, 3) : null,
    coverage: round(s.coverage, 3),
    meanConfidence: round(mean(s.conf.filter((_, i) => s.deg[i] !== null)), 3),
    depthShare: round(s.meanDepthShare, 3),
    // Wie gleichmäßig das Gelenk über die Wiederholungen arbeitet.
    perRep: extremes.map((e) => ({ min: round(e.min), max: round(e.max), range: round(e.max - e.min) })),
    consistency: extremes.length >= 2 ? consistencyOf(extremes) : null,
    jitter: round(jitterShare(s), 4),
    reliable: isReliable(s),
  };
}

/**
 * Anteil der Bilder, in denen der Winkel unmöglich schnell hin und zurück
 * springt — das Kennzeichen einer verlorenen Verfolgung.
 */
export function jitterShare(s) {
  let counted = 0;
  let bad = 0;
  for (let i = 1; i < s.deg.length - 1; i++) {
    const a = s.deg[i - 1];
    const b = s.deg[i];
    const c = s.deg[i + 1];
    if (a === null || b === null || c === null) continue;
    const dtBack = s.t[i] - s.t[i - 1];
    const dtFwd = s.t[i + 1] - s.t[i];
    if (dtBack <= 0 || dtFwd <= 0) continue;
    counted++;
    const vBack = (b - a) / dtBack;
    const vFwd = (c - b) / dtFwd;
    const reversal = Math.sign(vBack) !== Math.sign(vFwd);
    if (reversal && Math.abs(vBack) > IMPOSSIBLE_DEG_PER_S && Math.abs(vFwd) > IMPOSSIBLE_DEG_PER_S) bad++;
  }
  return counted ? bad / counted : 0;
}

function extremesIn(s, from, to) {
  let min = null;
  let max = null;
  for (let i = from; i <= to && i < s.deg.length; i++) {
    const d = s.deg[i];
    if (d === null) continue;
    if (min === null || d < min) min = d;
    if (max === null || d > max) max = d;
  }
  return { min, max };
}

/**
 * Streuung der Wiederholungen und ihr Trend.
 *
 * `sd` sagt, wie stark sich die Wiederholungen unterscheiden. `driftPerRep` ist
 * die Steigung einer Geraden durch die Werte, in Grad pro Wiederholung.
 *
 * Ob diese Steigung überhaupt etwas bedeutet, entscheidet `driftIsReal` — und
 * das ist die wichtigere der beiden Zahlen. Eine Gerade lässt sich durch drei
 * beliebige Punkte legen, und sie hat immer eine Steigung; bei drei
 * Wiederholungen mit ±47° Streuung „−40° pro Wiederholung" zu melden, ist keine
 * Beobachtung, sondern eine ausgerechnete Zufälligkeit. Geprüft wird deshalb
 * die Steigung gegen ihren eigenen Standardfehler: Sie muss ihn um mehr als das
 * Doppelte übertreffen, und es müssen mindestens vier Wiederholungen sein.
 */
function consistencyOf(extremes) {
  const depths = extremes.map((e) => e.max - e.min);
  const tr = trend(depths);
  return {
    meanRange: round(mean(depths)),
    sd: round(sd(depths)),
    driftPerRep: round(tr.slope),
    driftIsReal: tr.significant,
    driftT: round(tr.t, 2),
  };
}

/**
 * Ausgleichsgerade mit Standardfehler ihrer Steigung.
 *
 * `t` ist die Steigung in Einheiten ihres eigenen Fehlers. Ab etwa 2 ist ein
 * Trend bei diesen Stichprobengrößen ernst zu nehmen; darunter ist die
 * Steigung mit einer waagerechten Linie verträglich.
 */
export function trend(values) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n < 4) return { slope: slope(v), se: null, t: 0, significant: false };

  const b = slope(v);
  const mx = (n - 1) / 2;
  const my = mean(v);
  const a = my - b * mx;
  let ssRes = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (v[i] - (a + b * i)) ** 2;
    sxx += (i - mx) ** 2;
  }
  const se = Math.sqrt(ssRes / (n - 2) / sxx);
  // Liegen die Punkte exakt auf der Geraden, ist der Restfehler null und der
  // Quotient nicht definiert. Das ist nicht „keine Evidenz", sondern die
  // stärkstmögliche — ein Sonderfall, den man leicht andersherum programmiert
  // und der dann ausgerechnet die saubersten Verläufe verschweigt.
  const t = se > 0 ? b / se : Math.abs(b) > 1e-9 ? Infinity : 0;
  return { slope: b, se, t, significant: Math.abs(t) >= 2 };
}

/* ------------------------------------------------------------------ */
/* Wiederholungen                                                      */
/* ------------------------------------------------------------------ */

function describeReps(series, repResult) {
  const reps = repResult.reps ?? [];
  if (!reps.length) return { count: 0, list: [], cadence: null, tempo: null };

  // Für die Zeitstatistik nur die Wiederholungen, die ganz im Video liegen.
  const whole = reps.filter((r) => !r.truncated);
  const timed = whole.length >= 2 ? whole : reps;
  const durations = timed.map((r) => r.duration);
  const gaps = timed.slice(1).map((r, i) => r.tStart - timed[i].tStart);

  return {
    count: reps.length,
    direction: repResult.direction,
    list: reps.map((r) => ({
      index: r.index,
      truncated: r.truncated ?? false,
      tStart: round(r.tStart, 3),
      tExtreme: round(r.tPeak, 3),
      tEnd: round(r.tEnd, 3),
      duration: round(r.duration, 3),
      extreme: round(r.extreme),
      amplitude: round(r.amplitude),
    })),
    meanDuration: round(mean(durations), 3),
    durationSd: round(sd(durations), 3),
    cadence: gaps.length ? round(60 / mean(gaps), 1) : null,
    // Ob die Bewegung im Verlauf langsamer wird — die häufigste Form von
    // Ermüdung, die man in einem Video überhaupt sehen kann.
    // Wie bei den Winkeln: eine Steigung nur dann melden, wenn sie ihren
    // eigenen Fehler überragt.
    slowing: trend(durations).significant ? round(trend(durations).slope, 4) : null,
    timedOn: timed.length,
  };
}

/* ------------------------------------------------------------------ */
/* Seitenvergleich                                                     */
/* ------------------------------------------------------------------ */

/**
 * Links gegen rechts, aber nur, wo beide Seiten wirklich gesehen wurden.
 *
 * Der Vergleich ist die verführerischste Zahl im ganzen Bericht: Eine
 * Asymmetrie von 12° klingt nach einer Diagnose. Aus einer einzelnen Kamera ist
 * sie aber meistens Perspektive — die kameraferne Seite ist verdeckter und
 * stärker verkürzt als die nahe. Deshalb wird der Unterschied nur dann
 * ausgewiesen, wenn beide Seiten ordentlich sichtbar waren, und er trägt die
 * Verkürzungsdifferenz als Warnung mit.
 */
function describeSymmetry(series) {
  const byId = new Map(series.map((s) => [s.id, s]));
  const pairs = [
    ["kneeL", "kneeR", "Knie"],
    ["hipL", "hipR", "Hüfte"],
    ["elbowL", "elbowR", "Ellbogen"],
    ["shoulderL", "shoulderR", "Schulter"],
  ];

  const out = [];
  for (const [l, r, label] of pairs) {
    const left = byId.get(l);
    const right = byId.get(r);
    if (!left || !right) continue;
    if (!isReliable(left) || !isReliable(right)) continue;
    if (left.range < 8 && right.range < 8) continue; // beide bewegen sich kaum
    const depthGap = Math.abs(left.meanDepthShare - right.meanDepthShare);
    out.push({
      label,
      leftRange: round(left.range),
      rightRange: round(right.range),
      difference: round(left.range - right.range),
      // Bei stark unterschiedlicher Verkürzung ist der Unterschied vermutlich
      // die Kamera und nicht der Körper.
      perspectiveSuspect: depthGap > 0.25,
      depthGap: round(depthGap, 3),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Vorbehalte                                                          */
/* ------------------------------------------------------------------ */

function isReliable(s) {
  const conf = mean(s.conf.filter((_, i) => s.deg[i] !== null));
  return (
    s.coverage >= LOW_COVERAGE &&
    conf >= LOW_CONFIDENCE &&
    s.meanDepthShare <= HIGH_DEPTH_SHARE &&
    jitterShare(s) <= JITTER_LIMIT
  );
}

function collectCaveats(joints, meta) {
  const out = [];
  const lowCoverage = joints.filter((j) => j.coverage < LOW_COVERAGE).map((j) => j.label);
  const deep = joints.filter((j) => j.depthShare > HIGH_DEPTH_SHARE).map((j) => j.label);
  const unsure = joints.filter((j) => j.meanConfidence < LOW_CONFIDENCE).map((j) => j.label);

  if (lowCoverage.length) {
    out.push({
      id: "coverage",
      text:
        `In vielen Bildern nicht messbar: ${lowCoverage.join(", ")}. ` +
        "Meist ist der Körperteil verdeckt oder aus dem Bild gelaufen.",
      remedy: "Weiter weg filmen, sodass die ganze Person durchgehend im Bild bleibt.",
    });
  }
  if (deep.length) {
    out.push({
      id: "depth",
      text:
        `Perspektivisch heikel: ${deep.join(", ")}. Diese Gelenke zeigen überwiegend ` +
        "auf die Kamera zu; ihr Winkel hängt dann an der Tiefenschätzung, die aus einer " +
        "einzelnen Kamera die unsicherste Größe ist.",
      remedy: "Um 45° zur Seite gehen, sodass die Bewegungsebene quer zur Kamera liegt.",
    });
  }
  if (unsure.length) {
    out.push({
      id: "visibility",
      text: `Schwach erkannt: ${unsure.join(", ")}.`,
      remedy: "Mehr Licht, ruhigerer Hintergrund, Kleidung mit Kontrast zum Untergrund.",
    });
  }
  const jumpy = joints.filter((j) => j.jitter > JITTER_LIMIT);
  if (jumpy.length) {
    const worst = jumpy.reduce((a, b) => (b.jitter > a.jitter ? b : a));
    out.push({
      id: "tracking",
      text:
        `Die Verfolgung ist stellenweise abgerissen (${jumpy.map((j) => j.label).join(", ")}). ` +
        `Bei ${(worst.jitter * 100).toFixed(1)} % der Bilder springt der Winkel schneller hin und ` +
        "zurück, als ein Gelenk sich bewegen kann — dort hat das Modell jemand anderen oder gar " +
        "niemanden verfolgt. Die Extremwerte dieser Gelenke sind mit Vorsicht zu lesen.",
      remedy:
        "Den Ausschnitt auf die Bewegung selbst kürzen und Passagen weglassen, in denen die " +
        "Person den Bildrand berührt oder andere Personen sie überschneiden.",
    });
  }
  if (meta.fps && meta.fps < 25) {
    out.push({
      id: "framerate",
      text:
        `Nur ${Math.round(meta.fps)} Bilder pro Sekunde ausgewertet. Für Winkel reicht das, ` +
        "für Geschwindigkeiten und kurze Zeitabstände nicht.",
      remedy: "Mit 60 fps oder mehr filmen, falls die Kamera das kann.",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Kleine Statistik                                                    */
/* ------------------------------------------------------------------ */

export function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function sd(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** Steigung der Ausgleichsgeraden gegen den Index. */
export function slope(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(v);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (v[i] - my);
    den += (i - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function round(x, digits = 1) {
  if (x === null || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/* ------------------------------------------------------------------ */
/* Ausgabe als Tabelle                                                 */
/* ------------------------------------------------------------------ */

/** Alle Winkel Bild für Bild, als CSV — für Excel, R oder was sonst folgt. */
export function seriesToCsv(series) {
  const head = ["t_s", ...series.flatMap((s) => [s.id + "_deg", s.id + "_conf"])];
  const rows = [head.join(",")];
  const n = series[0]?.t.length ?? 0;
  for (let i = 0; i < n; i++) {
    const cells = [series[0].t[i].toFixed(4)];
    for (const s of series) {
      cells.push(s.deg[i] === null ? "" : s.deg[i].toFixed(2));
      cells.push(s.conf[i].toFixed(3));
    }
    rows.push(cells.join(","));
  }
  return rows.join("\n");
}
