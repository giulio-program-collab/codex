import {
  type Vec3,
  add3,
  clamp,
  dist2,
  dot3,
  mean,
  norm3,
  scale3,
  smooth,
  sub3,
} from "../core/math.ts";
import { backproject, type PinholeCamera } from "../core/camera.ts";
import type { FrameObservation, LayerReport, Pose3D } from "../core/types.ts";
import { dominantSide, sided, type Handedness } from "../core/types.ts";

/**
 * Layer 7 — Racket tracking.
 *
 * The racket is reconstructed the same way as a bone: its grip is anchored at
 * the hand, whose 3D position layer 6 already produced, and its length is
 * known, so the head's depth follows from the same quadratic. This matters
 * because racket-head speed is the number coaches ask for first and the number
 * a monocular system is least able to give: the head moves 40 m/s, which at
 * 1/250 s exposure smears it over 16 cm of image, and at 30 fps it travels
 * 1.3 m between frames.
 *
 * We therefore report racket-head speed only when the effective sampling rate
 * can resolve it, and even then as an interval, never as a single figure.
 */

export interface RacketFrame {
  index: number;
  grip: Vec3 | null;
  head: Vec3 | null;
  /** Racket long-axis direction, unit. */
  axis: Vec3 | null;
  /** Head speed in m/s, or null where it cannot be resolved. */
  headSpeedMs: number | null;
  confidence: number;
}

export interface RacketResult {
  report: LayerReport;
  frames: RacketFrame[];
  /** Fraction of frames with a usable racket observation. */
  coverage: number;
  /** True when the sampling rate cannot resolve racket-head speed at all. */
  speedResolvable: boolean;
  peakHeadSpeedMs: number | null;
  peakHeadSpeedSd: number | null;
}

/**
 * Minimum effective sampling rate for a racket-head speed claim.
 *
 * At 120 Hz the head moves about 0.33 m between samples at 40 m/s; the chord of
 * a curved path then under-reads the true tangential speed by a few percent,
 * which is tolerable. At 60 Hz the chord error exceeds 10 % and at 30 Hz the
 * head is simply somewhere else, so no honest figure exists.
 */
export const MIN_RACKET_SPEED_HZ = 120;

export interface RacketOptions {
  camera: PinholeCamera;
  poses3d: Pose3D[];
  hand: Handedness;
  racketLengthM: number;
  dtScene: number;
  effectiveHz: number;
}

export function trackRacket(frames: FrameObservation[], opts: RacketOptions): RacketResult {
  const notes: string[] = [];
  const cam = opts.camera;
  const side = dominantSide(opts.hand);
  const handJoint = sided("hand", side);

  // The racket head is solved exactly like a bone: it lies on its own ray, at a
  // known length from the hand. That leaves the same sign ambiguity, and it is
  // resolved the same way — by taking the whole clip into account rather than
  // one frame at a time. A single wrong choice at the start of the clip
  // propagates through every later frame by continuity, and a racket
  // reconstructed inside-out puts maximum arm extension in the follow-through,
  // which then drags the detected contact instant with it.
  const n = frames.length;
  const geometry: Array<{
    grip: Vec3;
    rayHead: Vec3;
    centre: number;
    magnitude: number;
    confidence: number;
  } | null> = new Array(n).fill(null);
  let observed = 0;

  for (let i = 0; i < n; i++) {
    const obs = frames[i].racket;
    const pose = opts.poses3d[i];
    const hand = pose?.[handJoint];
    if (!obs || !hand || obs.score < 0.25) continue;
    observed++;

    const grip = hand.p;
    const rayHead = backproject(cam, obs.head);
    const rayGrip = backproject(cam, obs.grip);
    // Distances are measured from the camera centre, whatever frame the caller
    // works in: layer 6 hands us poses in the court frame and a camera whose
    // pose is expressed in that same frame.
    const tGrip = norm3(sub3(grip, cam.position));
    const c = clamp(dot3(rayGrip, rayHead), -1, 1);
    const L = opts.racketLengthM;
    const disc = L * L - tGrip * tGrip * Math.max(0, 1 - c * c);
    if (disc <= 0) {
      geometry[i] = { grip, rayHead, centre: tGrip * c, magnitude: 0, confidence: obs.score * hand.confidence };
      continue;
    }
    geometry[i] = {
      grip,
      rayHead,
      centre: tGrip * c,
      magnitude: Math.sqrt(disc),
      confidence: clamp(obs.score * hand.confidence, 0, 1),
    };
  }

  const buildTrack = (preferNear: boolean): Array<Vec3 | null> => {
    const heads: Array<Vec3 | null> = new Array(n).fill(null);
    let previous: Vec3 | null = null;
    for (let i = 0; i < n; i++) {
      const g = geometry[i];
      if (!g) continue;
      const near = add3(cam.position, scale3(g.rayHead, g.centre - g.magnitude));
      const far = add3(cam.position, scale3(g.rayHead, g.centre + g.magnitude));
      let choice: Vec3;
      if (previous) {
        choice = norm3(sub3(near, previous)) <= norm3(sub3(far, previous)) ? near : far;
      } else {
        choice = preferNear ? near : far;
      }
      heads[i] = choice;
      previous = choice;
    }
    return heads;
  };

  /** Mean squared acceleration of a track; the smoother hypothesis is the right one. */
  const roughness = (heads: Array<Vec3 | null>): number => {
    let total = 0;
    let count = 0;
    for (let i = 1; i < n - 1; i++) {
      const a = heads[i - 1];
      const b = heads[i];
      const c = heads[i + 1];
      if (!a || !b || !c) continue;
      total += (a.x - 2 * b.x + c.x) ** 2 + (a.y - 2 * b.y + c.y) ** 2 + (a.z - 2 * b.z + c.z) ** 2;
      count++;
    }
    return count ? total / count : Number.POSITIVE_INFINITY;
  };

  const nearTrack = buildTrack(true);
  const farTrack = buildTrack(false);
  const heads = roughness(nearTrack) <= roughness(farTrack) ? nearTrack : farTrack;

  const out: RacketFrame[] = [];
  for (let i = 0; i < n; i++) {
    const g = geometry[i];
    const head = heads[i];
    if (!g || !head) {
      out.push({ index: i, grip: null, head: null, axis: null, headSpeedMs: null, confidence: 0 });
      continue;
    }
    const d = sub3(head, g.grip);
    const len = norm3(d);
    out.push({
      index: i,
      grip: g.grip,
      head,
      axis: len > 1e-6 ? scale3(d, 1 / len) : null,
      headSpeedMs: null,
      confidence: g.confidence,
    });
  }
  // --- Head speed -------------------------------------------------------
  const speedResolvable = opts.effectiveHz >= MIN_RACKET_SPEED_HZ;
  let peakHeadSpeedMs: number | null = null;
  let peakHeadSpeedSd: number | null = null;

  if (speedResolvable) {
    const speeds: number[] = [];
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1].head;
      const b = out[i].head;
      speeds.push(a && b ? norm3(sub3(b, a)) / opts.dtScene : NaN);
    }
    const finite = speeds.map((v) => (Number.isFinite(v) ? v : 0));
    const sm = smooth(finite, 1);
    for (let i = 1; i < out.length; i++) {
      out[i].headSpeedMs = Number.isFinite(speeds[i - 1]) ? sm[i - 1] : null;
    }
    const valid = out
      .filter((f) => f.headSpeedMs !== null && f.confidence > 0.3)
      .map((f) => f.headSpeedMs as number);
    if (valid.length >= 5) {
      peakHeadSpeedMs = Math.max(...valid);
      // Uncertainty: chord-vs-arc shortening plus the propagated position error
      // of the two endpoints.
      const chordError = 0.06 * (120 / opts.effectiveHz);
      const posSigma = 0.05;
      peakHeadSpeedSd = Math.hypot(
        peakHeadSpeedMs * chordError,
        (posSigma * Math.SQRT2) / opts.dtScene / 3,
      );
    }
  } else {
    notes.push(
      `Schlägerkopfgeschwindigkeit wird nicht ausgegeben: ${opts.effectiveHz} Hz reichen dafür nicht ` +
        `(erforderlich ${MIN_RACKET_SPEED_HZ} Hz). Bei ${opts.effectiveHz} Hz legt der Schlägerkopf ` +
        `zwischen zwei Bildern über einen Meter zurück.`,
    );
  }

  const coverage = frames.length ? observed / frames.length : 0;
  if (coverage < 0.6) {
    notes.push(`Schläger nur in ${Math.round(coverage * 100)} % der Bilder erkannt.`);
  }
  const meanConf = clamp(mean(out.map((f) => f.confidence)) ?? 0, 0, 1);

  return {
    report: {
      id: "L7",
      name: "Schlägererkennung",
      status: coverage > 0.7 ? "ok" : coverage > 0.3 ? "degraded" : "failed",
      quality: clamp(coverage * (0.4 + 0.6 * meanConf), 0, 1),
      notes,
      diagnostics: {
        abdeckungProzent: Number((coverage * 100).toFixed(1)),
        mittlereSicherheit: Number(meanConf.toFixed(2)),
        geschwindigkeitAufloesbar: speedResolvable ? "ja" : "nein",
        spitzengeschwindigkeitMs: peakHeadSpeedMs === null ? null : Number(peakHeadSpeedMs.toFixed(1)),
      },
    },
    frames: out,
    coverage,
    speedResolvable,
    peakHeadSpeedMs,
    peakHeadSpeedSd,
  };
}

/** Convenience for the report layer. */
export const msToKmh = (v: number): number => v * 3.6;

/** Distance from the racket's long axis to a point, used for contact detection. */
export function distanceToRacketAxis(frame: RacketFrame, point: Vec3): number | null {
  if (!frame.grip || !frame.axis) return null;
  const d = sub3(point, frame.grip);
  const along = dot3(d, frame.axis);
  const perp = sub3(d, scale3(frame.axis, along));
  return norm3(perp);
}

/** 2D fallback used when no 3D hand anchor exists. */
export function racketLengthPx(obs: { grip: { x: number; y: number }; head: { x: number; y: number } }): number {
  return dist2(obs.grip, obs.head);
}
