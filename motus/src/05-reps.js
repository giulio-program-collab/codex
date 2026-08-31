/**
 * Schritt 5 — Wiederholungen finden.
 *
 * Eine Bewegung ist selten eine. Zehn Kniebeugen, sechs Aufschläge, ein Satz
 * Klimmzüge — und interessant wird es erst, wenn man sie nebeneinander legt:
 * Wird die achte flacher als die erste? Wird die Bewegung langsamer? Ist links
 * anders als rechts?
 *
 * Dafür muss das Werkzeug wissen, wo eine Wiederholung anfängt und aufhört. Es
 * bekommt das nicht gesagt und weiß auch nicht, welche Sportart es sieht. Was
 * es hat, ist ein Winkelverlauf — und Wiederholungen sind darin genau das, was
 * sie im Wortsinn sind: wiederkehrende Ausschläge.
 *
 * Das Verfahren ist Extremwertsuche über **Prominenz**, nicht über eine
 * Schwelle. Der Unterschied ist der ganze Trick.
 *
 *   Eine Schwelle („zähle, wenn der Winkel unter 90° geht") scheitert an dem,
 *   was Menschen tatsächlich tun: Die erste Kniebeuge geht auf 85°, die letzte
 *   nur noch auf 92°, und die Zählung verliert sie. Sie scheitert außerdem an
 *   jeder Sportart, für die die Zahl nicht eingestellt wurde.
 *
 *   Prominenz fragt stattdessen: Wie weit muss man von diesem Gipfel
 *   absteigen, bevor man wieder höher hinaufkommt? Ein echtes Tal zwischen
 *   zwei Wiederholungen hat eine große Prominenz, egal auf welcher Höhe es
 *   liegt. Zittern im Signal hat eine kleine. Die Grenze dazwischen wird nicht
 *   geraten, sondern aus der Spannweite des Signals selbst genommen.
 */

/** Ein Tal muss mindestens diesen Anteil der Gesamtspannweite tief sein. */
export const MIN_PROMINENCE_SHARE = 0.35;

/**
 * Zwei absolute Schranken, ohne die die relative Schwelle sich selbst betrügt.
 *
 * Prominenz „mindestens 35 % der Spannweite" ist gegenüber der Höhe des Signals
 * unempfindlich — das ist der Sinn der Sache — aber auch gegenüber seiner
 * Größe. Ein Gelenk, das nur zittert, hat eine Spannweite von 6°, und ein
 * Zufallsausschlag von 2° erfüllt darin brav die 35 %. Aus reinem Rauschen
 * werden so zwanzig „Wiederholungen".
 *
 * Deshalb zusätzlich: Ein Gelenk, das sich über die ganze Aufnahme um weniger
 * als `MIN_RANGE_DEG` bewegt, hat keine Wiederholungen, sondern steht still.
 * Und ein einzelner Ausschlag zählt erst ab `MIN_PROMINENCE_DEG`, gleich wie
 * groß das Signal drumherum ist. Beide Zahlen sind bewusst niedrig: Sie sollen
 * Rauschen ausschließen, nicht kleine Bewegungen.
 */
export const MIN_RANGE_DEG = 15;
export const MIN_PROMINENCE_DEG = 8;

/** Zwei Wiederholungen liegen mindestens so weit auseinander, in Sekunden. */
export const MIN_REP_SECONDS = 0.35;

/**
 * Findet Wiederholungen in einem Winkelverlauf.
 *
 * `direction` sagt, wie die Bewegung aussieht:
 *   "down" — der Winkel wird kleiner (Kniebeuge, Bizepscurl): eine
 *            Wiederholung ist ein Tal zwischen zwei Gipfeln.
 *   "up"   — der Winkel wird größer (Aufschlag-Streckung): ein Gipfel
 *            zwischen zwei Tälern.
 * Ohne Angabe entscheidet das Signal selbst, indem beide Varianten probiert
 * werden und die genommen wird, die mehr saubere Wiederholungen liefert.
 */
export function findRepetitions(series, options = {}) {
  const auto = !options.direction;
  const candidates = auto ? ["down", "up"] : [options.direction];
  let best = { reps: [], direction: candidates[0], extremes: [] };

  for (const direction of candidates) {
    const found = detect(series, { ...options, direction });
    if (found.reps.length > best.reps.length) best = found;
  }
  return best;
}

function detect(series, options) {
  const share = options.minProminenceShare ?? MIN_PROMINENCE_SHARE;
  const minGap = options.minSeconds ?? MIN_REP_SECONDS;
  const direction = options.direction;

  // Nach innen gedrehtes Signal: Wir suchen immer Gipfel. Bei "down" ist der
  // Gipfel das umgedrehte Tal, sonst wäre der Code zweimal da.
  const sign = direction === "down" ? -1 : 1;
  const y = series.deg.map((d) => (d === null ? null : sign * d));
  const t = series.t;

  const spread = spanOf(y);
  if (spread === null || spread < (options.minRangeDeg ?? MIN_RANGE_DEG)) {
    return { reps: [], direction, extremes: [], reason: "zu wenig Bewegung" };
  }
  const minProminence = Math.max(spread * share, options.minProminenceDeg ?? MIN_PROMINENCE_DEG);

  const peaks = findPeaks(y, t, minProminence, minGap);
  if (peaks.length === 0) return { reps: [], direction, extremes: [] };

  // Zwischen zwei Gipfeln liegt ein Tal; eine Wiederholung reicht von Tal zu
  // Tal und hat den Gipfel in der Mitte. Vor dem ersten und nach dem letzten
  // Gipfel wird bis zum jeweils tiefsten Punkt gegangen.
  const reps = [];
  for (let k = 0; k < peaks.length; k++) {
    const peak = peaks[k];
    const from = k === 0 ? lowestBefore(y, peak.i) : lowestBetween(y, peaks[k - 1].i, peak.i);
    const to = k === peaks.length - 1 ? lowestAfter(y, peak.i) : lowestBetween(y, peak.i, peaks[k + 1].i);
    if (from === null || to === null || to <= from) continue;
    // Eine Wiederholung, die kürzer ist als der Mindestabstand zweier
    // Wiederholungen, ist keine. Am Ende einer Aufnahme entsteht so etwas
    // regelmäßig: Die Person läuft aus dem Bild, das Modell verliert sie, und
    // die Winkel schlagen ein paar Bilder lang wild aus. Das sieht in der
    // Kurve aus wie ein Ausschlag und ist einer — nur keiner des Körpers.
    if (t[to] - t[from] < minGap) continue;
    reps.push({
      index: reps.length + 1,
      startFrame: from,
      peakFrame: peak.i,
      endFrame: to,
      tStart: t[from],
      tPeak: t[peak.i],
      tEnd: t[to],
      duration: t[to] - t[from],
      // Zurück in die Welt der echten Winkel.
      extreme: sign * y[peak.i],
      startDeg: sign * y[from],
      endDeg: sign * y[to],
      amplitude: Math.abs(y[peak.i] - Math.max(y[from], y[to])),
      prominence: peak.prominence,
      // Die erste und die letzte Wiederholung können vom Anfang bzw. Ende der
      // Aufnahme abgeschnitten sein. Sie werden gezeigt, zählen aber bei den
      // Dauern nicht mit — sonst verkürzt der Videoschnitt das Ergebnis.
      truncated: from === 0 || to === y.length - 1,
    });
  }

  return { reps, direction, extremes: peaks.map((p) => p.i) };
}

/* ------------------------------------------------------------------ */
/* Gipfelsuche                                                         */
/* ------------------------------------------------------------------ */

/**
 * Alle lokalen Maxima mit ausreichender Prominenz und Abstand.
 *
 * Die Prominenz eines Gipfels ist seine Höhe über dem höchsten Tal, das man
 * überqueren muss, um einen höheren Gipfel zu erreichen. Sie wird hier direkt
 * nach dieser Definition bestimmt: von jedem Kandidaten nach links und rechts
 * laufen, bis das Signal höher steigt oder das Ende kommt, und das jeweils
 * tiefste dabei gesehene Tal merken.
 */
export function findPeaks(y, t, minProminence, minGap) {
  const n = y.length;
  const candidates = [];
  for (let i = 1; i < n - 1; i++) {
    if (y[i] === null || y[i - 1] === null || y[i + 1] === null) continue;
    // `>=` links und `>` rechts, damit ein Plateau genau einmal zählt.
    if (y[i] >= y[i - 1] && y[i] > y[i + 1]) candidates.push(i);
  }

  const withProminence = candidates.map((i) => ({ i, prominence: prominenceAt(y, i) }));
  const strong = withProminence
    .filter((p) => p.prominence >= minProminence)
    .sort((a, b) => b.prominence - a.prominence);

  // Der stärkste Gipfel gewinnt sein Umfeld: Wer zu nah an einem schon
  // angenommenen liegt, ist derselbe Ausschlag, zweimal gezählt.
  const kept = [];
  for (const p of strong) {
    if (kept.every((q) => Math.abs(t[p.i] - t[q.i]) >= minGap)) kept.push(p);
  }
  return kept.sort((a, b) => a.i - b.i);
}

function prominenceAt(y, i) {
  const walk = (step) => {
    let lowest = y[i];
    for (let j = i + step; j >= 0 && j < y.length; j += step) {
      if (y[j] === null) break;
      if (y[j] > y[i]) return lowest; // höherer Gipfel erreicht
      if (y[j] < lowest) lowest = y[j];
    }
    return lowest; // Rand erreicht, ohne etwas Höheres zu finden
  };
  return y[i] - Math.max(walk(-1), walk(1));
}

function lowestBetween(y, a, b) {
  let best = null;
  for (let i = a; i <= b; i++) {
    if (y[i] === null) continue;
    if (best === null || y[i] < y[best]) best = i;
  }
  return best;
}

const lowestBefore = (y, i) => lowestBetween(y, 0, i);
const lowestAfter = (y, i) => lowestBetween(y, i, y.length - 1);

function spanOf(y) {
  const xs = y.filter((v) => v !== null);
  if (xs.length < 3) return null;
  return Math.max(...xs) - Math.min(...xs);
}
