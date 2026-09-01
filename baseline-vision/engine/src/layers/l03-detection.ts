import { clamp, dist2, median } from "../core/math.ts";
import type { FrameObservation, LayerReport } from "../core/types.ts";

/**
 * Layer 3 — Player detection and track selection.
 *
 * The input already carries one pose per frame, so this layer's job is not to
 * find the player but to check that it is the *same* player throughout. An
 * identity switch to a partner, a ball kid or a spectator is invisible in every
 * downstream number and produces confident nonsense — it is the fourth item on
 * the outlier list and the easiest one to catch cheaply.
 */

export interface DetectionResult {
  report: LayerReport;
  /** Frames flagged as belonging to a different subject. */
  identitySwitchFrames: number[];
  trackContinuity: number;
}

export function detectPlayerTrack(frames: FrameObservation[]): DetectionResult {
  const notes: string[] = [];
  const switches: number[] = [];

  // Torso centroid and apparent body size are the two cheapest identity cues.
  const centroids: Array<{ x: number; y: number } | null> = [];
  const sizes: Array<number | null> = [];
  for (const f of frames) {
    const pts = Object.values(f.pose2d).filter((k) => k && k.score > 0.4);
    if (pts.length < 5) {
      centroids.push(null);
      sizes.push(null);
      continue;
    }
    const cx = pts.reduce((s, k) => s + k!.p.x, 0) / pts.length;
    const cy = pts.reduce((s, k) => s + k!.p.y, 0) / pts.length;
    centroids.push({ x: cx, y: cy });
    const head = f.pose2d.head;
    const ankle = f.pose2d.ankleL ?? f.pose2d.ankleR;
    sizes.push(head && ankle ? dist2(head.p, ankle.p) : null);
  }

  const steps: number[] = [];
  for (let i = 1; i < centroids.length; i++) {
    const a = centroids[i - 1];
    const b = centroids[i];
    if (a && b) steps.push(dist2(a, b));
  }
  const medStep = median(steps) ?? 0;
  const medSize = median(sizes.filter((s): s is number => s !== null)) ?? 0;

  for (let i = 1; i < centroids.length; i++) {
    const a = centroids[i - 1];
    const b = centroids[i];
    if (!a || !b) continue;
    const jump = dist2(a, b);
    const sizeNow = sizes[i];
    // A body-sized centroid jump in one frame, or a sudden change in apparent
    // stature, is an identity switch rather than a fast movement.
    const centroidSwitch = medSize > 0 && jump > Math.max(0.35 * medSize, 8 * (medStep + 1));
    const sizeSwitch = sizeNow !== null && medSize > 0 && Math.abs(sizeNow - medSize) > 0.3 * medSize;
    if (centroidSwitch || sizeSwitch) switches.push(i);
  }

  const continuity = frames.length === 0 ? 0 : clamp(1 - switches.length / frames.length, 0, 1);
  if (switches.length > 0) {
    notes.push(
      `${switches.length} mögliche Identitätswechsel im Track (Bilder ${switches.slice(0, 6).join(", ")}` +
        `${switches.length > 6 ? " …" : ""}). Prüfen, ob durchgehend derselbe Spieler verfolgt wurde.`,
    );
  }

  return {
    report: {
      id: "L3",
      name: "Spielererkennung & Track",
      status: switches.length === 0 ? "ok" : continuity > 0.9 ? "degraded" : "failed",
      quality: continuity,
      notes,
      diagnostics: {
        identitaetswechsel: switches.length,
        medianKoerperhoehePx: Number(medSize.toFixed(1)),
        medianVersatzPx: Number(medStep.toFixed(2)),
      },
    },
    identitySwitchFrames: switches,
    trackContinuity: continuity,
  };
}
