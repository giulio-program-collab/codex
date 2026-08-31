/**
 * Das Skelett über dem Video.
 *
 * Die Zeichnung benutzt die Bildkoordinaten aus Schritt 2, nicht die
 * Weltkoordinaten — sie soll auf dem Video liegen, nicht im Raum stehen.
 *
 * Punkte, die das Modell nur schwach gesehen hat, werden blasser gezeichnet
 * statt weggelassen. Das ist Absicht: Ein verschwindendes Gelenk sieht aus wie
 * ein Fehler im Programm, ein blasses sieht aus wie das, was es ist — eine
 * unsichere Schätzung.
 */

import { SKELETON_EDGES } from "./02-pose.js";

const LIMB = "#5ad6c8";
const JOINT = "#f2f7f8";
const WEAK = 0.45;

/** Zeichnet eine Pose in einen Canvas, der über dem Video liegt. */
export function drawPose(ctx, pose, width, height, options = {}) {
  ctx.clearRect(0, 0, width, height);
  if (!pose?.image) return;

  const P = pose.image;
  const scale = Math.min(width, height) / 480;
  const at = (p) => [p.x * width, p.y * height];

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Erst ein dunkler Rand unter jeder Linie, damit das Skelett auch auf einem
  // hellen Hintergrund lesbar bleibt. Ohne das verschwindet es auf Sand,
  // Schnee und jedem überbelichteten Video.
  for (const pass of ["shadow", "line"]) {
    ctx.strokeStyle = pass === "shadow" ? "rgba(6,12,14,0.75)" : LIMB;
    ctx.lineWidth = (pass === "shadow" ? 7 : 3.5) * scale;
    for (const [a, b] of SKELETON_EDGES) {
      const pa = P[a];
      const pb = P[b];
      if (!pa || !pb) continue;
      ctx.globalAlpha = Math.min(pa.v, pb.v) < 0.5 ? WEAK : 1;
      ctx.beginPath();
      ctx.moveTo(...at(pa));
      ctx.lineTo(...at(pb));
      ctx.stroke();
    }
  }

  // Nur die Gelenke, die MOTUS auch misst — die Punkte im Gesicht sind für die
  // Bewegungsanalyse Dekoration und lenken vom Rest ab.
  const measured = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
  for (const i of measured) {
    const p = P[i];
    if (!p) continue;
    const [x, y] = at(p);
    ctx.globalAlpha = p.v < 0.5 ? WEAK : 1;
    ctx.beginPath();
    ctx.arc(x, y, 4.5 * scale, 0, Math.PI * 2);
    ctx.fillStyle = JOINT;
    ctx.fill();
    ctx.lineWidth = 1.5 * scale;
    ctx.strokeStyle = "rgba(6,12,14,0.85)";
    ctx.stroke();
  }

  // Das Gelenk, das gerade im Diagramm zu sehen ist, wird hervorgehoben —
  // damit die Kurve und der Körper dieselbe Sache sind und nicht zwei.
  if (options.highlight != null && P[options.highlight]) {
    const [x, y] = at(P[options.highlight]);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(x, y, 12 * scale, 0, Math.PI * 2);
    ctx.strokeStyle = "#c9dd3c";
    ctx.lineWidth = 2.5 * scale;
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}
