/**
 * Das Diagramm: ein Winkel über die Zeit.
 *
 * Selbst gezeichnet, ohne Bibliothek — nicht aus Sparsamkeit, sondern weil drei
 * Dinge nötig sind, die kein Standard-Diagramm von sich aus kann:
 *
 *   1. **Lücken bleiben Lücken.** Wo nicht gemessen werden konnte, wird die
 *      Linie unterbrochen. Die meisten Bibliotheken verbinden über fehlende
 *      Werte hinweg, und dann sieht eine Stelle, an der das Knie verdeckt war,
 *      aus wie eine ruhige Phase.
 *   2. **Unsicherheit ist sichtbar.** Bilder mit schwacher Erkennung werden
 *      blass gezeichnet. Die Linie sagt damit selbst, wo man ihr trauen kann.
 *   3. **Die Wiederholungen liegen darunter**, als Bänder, und die Zeitmarke
 *      des Videos läuft mit.
 */

const INK = "#e8eef0";
const SOFT = "#8fa2a9";
const FAINT = "#3a474d";
const LINE = "#5ad6c8";
const MARK = "#c9dd3c";
const BAND = "rgba(90, 214, 200, 0.10)";

export class AngleChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.series = null;
    this.reps = [];
    this.cursor = null; // Zeit des Videos
    this.hover = null; // Zeit unter dem Mauszeiger
    this.pad = { l: 52, r: 14, t: 14, b: 30 };
  }

  setData(series, reps) {
    this.series = series;
    this.reps = reps ?? [];
    this.draw();
  }

  setCursor(t) {
    this.cursor = t;
    this.draw();
  }

  /** Rechnet einen Punkt im Canvas in eine Videozeit um — für Klick und Hover. */
  timeAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.canvas.width;
    const { l, r } = this.pad;
    const w = this.canvas.width - l - r;
    const s = this.series;
    if (!s || w <= 0) return null;
    const frac = Math.max(0, Math.min(1, (x - l) / w));
    return s.t[0] + frac * (s.t.at(-1) - s.t[0]);
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const s = this.series;
    if (!s || !s.t.length) return;

    const { l, r, t: pt, b } = this.pad;
    const plotW = W - l - r;
    const plotH = H - pt - b;
    const t0 = s.t[0];
    const t1 = s.t.at(-1);

    // Achsenbereich: die gemessene Spanne, aufgerundet auf glatte Zehner, mit
    // etwas Luft. Nicht bei null anfangen — ein Kniewinkel zwischen 78° und
    // 172° in einer Achse von 0 bis 180 ist eine flache Linie in der Mitte.
    const values = s.deg.filter((d) => d !== null);
    if (!values.length) return;
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const margin = Math.max(4, (hi - lo) * 0.12);
    // Auf glatte Zehner runden, aber nicht über den Wertebereich hinaus, den
    // ein Gelenkwinkel überhaupt haben kann: Eine Achse, die bei −10° anfängt,
    // behauptet einen Bereich, den es nicht gibt.
    lo = Math.max(0, Math.floor((lo - margin) / 10) * 10);
    hi = Math.min(180, Math.ceil((hi + margin) / 10) * 10);

    const X = (time) => l + ((time - t0) / (t1 - t0 || 1)) * plotW;
    const Y = (deg) => pt + (1 - (deg - lo) / (hi - lo || 1)) * plotH;

    // Wiederholungen als Bänder, abwechselnd getönt.
    this.reps.forEach((rep, i) => {
      if (i % 2) return;
      ctx.fillStyle = BAND;
      ctx.fillRect(X(rep.tStart), pt, X(rep.tEnd) - X(rep.tStart), plotH);
    });

    // Gitter und Beschriftung
    ctx.strokeStyle = FAINT;
    ctx.fillStyle = SOFT;
    ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = lo; v <= hi; v += niceStep(hi - lo)) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(W - r, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(v), l - 8, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const tStep = niceTimeStep(t1 - t0);
    for (let time = Math.ceil(t0 / tStep) * tStep; time <= t1; time += tStep) {
      ctx.fillText(time.toFixed(tStep < 1 ? 1 : 0) + " s", X(time), H - b + 8);
    }

    // Die Kurve, abschnittsweise: Lücken trennen, schwache Erkennung blasst ab.
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    let open = false;
    let lastAlpha = null;
    for (let i = 0; i < s.deg.length; i++) {
      const d = s.deg[i];
      if (d === null) {
        if (open) ctx.stroke();
        open = false;
        continue;
      }
      const alpha = s.conf[i] < 0.5 ? 0.3 : s.conf[i] < 0.75 ? 0.6 : 1;
      if (!open || alpha !== lastAlpha) {
        if (open) ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = LINE;
        ctx.globalAlpha = alpha;
        ctx.moveTo(X(s.t[i]), Y(d));
        open = true;
        lastAlpha = alpha;
      } else {
        ctx.lineTo(X(s.t[i]), Y(d));
      }
    }
    if (open) ctx.stroke();
    ctx.globalAlpha = 1;

    // Der Extremwert jeder Wiederholung
    ctx.fillStyle = MARK;
    for (const rep of this.reps) {
      const x = X(rep.tPeak);
      const y = Y(rep.extreme);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Die Stelle, an der das Video gerade steht
    if (this.cursor !== null && this.cursor >= t0 && this.cursor <= t1) {
      const x = Math.round(X(this.cursor)) + 0.5;
      ctx.strokeStyle = MARK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, pt);
      ctx.lineTo(x, pt + plotH);
      ctx.stroke();

      const i = nearestIndex(s.t, this.cursor);
      const d = s.deg[i];
      if (d !== null) {
        const label = `${d.toFixed(0)}°`;
        ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
        const w = ctx.measureText(label).width + 12;
        const bx = Math.min(W - r - w, Math.max(l, x + 6));
        ctx.fillStyle = "rgba(10,16,18,0.9)";
        ctx.fillRect(bx, pt + 4, w, 22);
        ctx.fillStyle = MARK;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, bx + w / 2, pt + 15);
      }
    }

    // Achsenbeschriftung links
    ctx.save();
    ctx.translate(14, pt + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = SOFT;
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.label + " (°)", 0, 0);
    ctx.restore();
    void INK;
  }
}

function nearestIndex(times, t) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function niceStep(span) {
  for (const s of [5, 10, 20, 25, 50, 100]) if (span / s <= 8) return s;
  return 200;
}

function niceTimeStep(span) {
  for (const s of [0.5, 1, 2, 5, 10, 20, 30, 60]) if (span / s <= 9) return s;
  return 120;
}
