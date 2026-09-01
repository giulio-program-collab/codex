import { type Vec2, clamp, dist2, mean, median } from "../core/math.ts";
import type { FrameObservation, LayerReport } from "../core/types.ts";

/**
 * Layer 8 — Ball tracking.
 *
 * The ball is the least reliable object in the frame and the most tempting to
 * over-claim about. A serve leaves the racket at 50-60 m/s; at 30 fps it moves
 * nearly two metres between frames and is usually not detected at all in the
 * first frames after contact. Its depth from a single camera comes only from
 * its apparent radius, which is a handful of pixels — a 1-pixel radius error at
 * 4 px radius is a 25 % depth error.
 *
 * So this layer produces exactly two things it can defend: a 2D track, and the
 * frame of contact. Ball speed and launch angle are explicitly declared
 * unobservable from a single uncalibrated camera and are never estimated.
 */

export interface BallTrack {
  index: number;
  p: Vec2 | null;
  radiusPx: number | null;
  score: number;
  /** Coarse depth from apparent size; informative only, never used for speed. */
  approxDepthM: number | null;
}

export interface BallResult {
  report: LayerReport;
  track: BallTrack[];
  coverage: number;
  /**
   * Frame at which the ball's image trajectory reverses — the strongest
   * single-camera evidence of contact. Fractional: the reversal is located
   * between samples.
   */
  contactFrameFromBall: number | null;
  contactConfidence: number;
}

const BALL_RADIUS_M = 0.0335;

export interface BallOptions {
  focalPx: number;
  /** Effective sampling rate, for the contact-timing uncertainty. */
  effectiveHz: number;
}

export function trackBall(frames: FrameObservation[], opts: BallOptions): BallResult {
  const notes: string[] = [];
  const track: BallTrack[] = frames.map((f, i) => {
    const b = f.ball;
    if (!b || b.score < 0.2) {
      return { index: i, p: null, radiusPx: null, score: 0, approxDepthM: null };
    }
    return {
      index: i,
      p: b.p,
      radiusPx: b.radiusPx,
      score: b.score,
      approxDepthM: b.radiusPx > 1 ? (opts.focalPx * BALL_RADIUS_M) / b.radiusPx : null,
    };
  });

  const observed = track.filter((t) => t.p).length;
  const coverage = frames.length ? observed / frames.length : 0;

  // --- Contact from trajectory reversal ---------------------------------
  // Before contact the ball rises and decelerates; after contact it moves in a
  // qualitatively different direction at a much higher speed. The sign change
  // of the vertical image velocity, combined with a step in speed, localises
  // the contact to within a frame or two.
  let contactFrameFromBall: number | null = null;
  let contactConfidence = 0;

  const vy: Array<number | null> = [];
  const speed: Array<number | null> = [];
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1].p;
    const b = track[i].p;
    if (!a || !b) {
      vy.push(null);
      speed.push(null);
      continue;
    }
    vy.push(b.y - a.y);
    speed.push(dist2(a, b));
  }

  const speeds = speed.filter((s): s is number => s !== null);
  const typical = median(speeds) ?? 0;
  let best: { i: number; jump: number } | null = null;
  for (let i = 1; i < vy.length; i++) {
    const prev = vy[i - 1];
    const now = vy[i];
    const sPrev = speed[i - 1];
    const sNow = speed[i];
    if (prev === null || now === null || sPrev === null || sNow === null) continue;
    // Image y grows downward: a rising toss has vy < 0, a struck ball vy > 0
    // is not guaranteed, so the robust cue is the speed step.
    const jump = sNow - sPrev;
    if (jump > Math.max(2.5 * typical, 6) && (!best || jump > best.jump)) {
      best = { i: i + 1, jump };
    }
  }
  if (best) {
    contactFrameFromBall = best.i;
    contactConfidence = clamp(0.4 + 0.4 * clamp(best.jump / Math.max(typical * 5, 1), 0, 1), 0, 0.85);
  } else if (coverage > 0.2) {
    notes.push("Kein eindeutiger Geschwindigkeitssprung im Ballpfad — Treffpunkt nicht über den Ball bestimmbar.");
  }

  if (coverage < 0.35) {
    notes.push(
      `Ball nur in ${Math.round(coverage * 100)} % der Bilder erkannt. ` +
        "Ballgeschwindigkeit und Abflugwinkel werden grundsätzlich nicht geschätzt.",
    );
  }

  const meanScore = clamp(mean(track.filter((t) => t.p).map((t) => t.score)) ?? 0, 0, 1);
  // As in layer 7: a clip that never carried a ball track is not a clip whose
  // ball track failed.
  const supplied = frames.some((f) => f.ball);
  if (!supplied) {
    notes.push(
      "Keine Ballbeobachtungen im Material. Der Treffpunkt muss daher aus der Bewegung oder " +
        "aus einer Markierung stammen.",
    );
  }

  return {
    report: {
      id: "L8",
      name: "Ballerkennung",
      status: !supplied ? "skipped" : coverage > 0.5 ? "ok" : coverage > 0.15 ? "degraded" : "failed",
      quality: clamp(coverage * (0.4 + 0.6 * meanScore), 0, 1),
      notes,
      diagnostics: {
        abdeckungProzent: Number((coverage * 100).toFixed(1)),
        mittlereSicherheit: Number(meanScore.toFixed(2)),
        treffpunktBildAusBall: contactFrameFromBall,
        treffpunktSicherheit: Number(contactConfidence.toFixed(2)),
      },
    },
    track,
    coverage,
    contactFrameFromBall,
    contactConfidence,
  };
}

/**
 * Quantities this layer will never produce from a single uncalibrated camera.
 * Listed explicitly so the interpretation layer can say *why* something is
 * missing rather than silently omitting it.
 */
export const BALL_UNOBSERVABLE = [
  {
    id: "ballSpeed",
    label: "Ballgeschwindigkeit",
    reason:
      "Aus einer unkalibrierten Kamera nicht bestimmbar: Die Tiefe des Balls folgt nur aus seinem " +
      "Bildradius (wenige Pixel), und unmittelbar nach dem Treffpunkt ist der Ball wegen " +
      "Bewegungsunschärfe meist gar nicht detektierbar.",
  },
  {
    id: "ballSpin",
    label: "Drall / Spin",
    reason: "Erfordert Hochgeschwindigkeitsaufnahmen mit sichtbarer Ballnaht oder Radar-/Hawk-Eye-Daten.",
  },
  {
    id: "launchAngle",
    label: "Abflugwinkel",
    reason: "Setzt eine kalibrierte Platzgeometrie und einen sicheren Balltrack nach dem Treffpunkt voraus.",
  },
] as const;
