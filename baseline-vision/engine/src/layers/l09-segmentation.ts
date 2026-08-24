import {
  angle3,
  clamp,
  derivative,
  mean,
  median,
  norm3,
  normalCdf,
  refinedPeak,
  sampleAt,
  smooth,
  sub3,
} from "../core/math.ts";
import {
  dominantSide,
  otherSide,
  sided,
  type Handedness,
  type Joint,
  type LayerReport,
  type Pose3D,
  type StrokeType,
} from "../core/types.ts";
import type { RacketFrame } from "./l07-racket.ts";

/**
 * Layer 9 — Stroke segmentation.
 *
 * Phases are located from continuous 3D signals, not from a coach clicking key
 * frames. Every boundary carries its own confidence, derived from how sharply
 * the underlying signal actually defines it: the instant of peak knee flexion
 * is a well-defined extremum, while the start of the unit turn is a gradual
 * onset and is reported as such.
 *
 * Boundaries are located to sub-frame resolution by parabolic interpolation
 * around each extremum. This is not decoration: at 60 fps a frame is 17 ms and
 * the differences the kinetic-chain analysis has to resolve are around 18 ms.
 */

export type ServePhaseId =
  | "preparation"
  | "toss"
  | "loading"
  | "leg_drive"
  | "racquet_drop"
  | "acceleration"
  | "contact"
  | "follow_through"
  | "landing";

export type GroundstrokePhaseId =
  | "ready"
  | "unit_turn"
  | "backswing"
  | "loading"
  | "forward_swing"
  | "contact"
  | "follow_through"
  | "recovery";

export type PhaseId = ServePhaseId | GroundstrokePhaseId;

export interface Phase {
  id: PhaseId;
  label: string;
  /** Fractional frame indices; fractional because boundaries are sub-frame. */
  startFrame: number;
  endFrame: number;
  startS: number;
  endS: number;
  /** Confidence that this boundary is where the system says it is. */
  confidence: number;
}

export interface SegmentationResult {
  report: LayerReport;
  phases: Phase[];
  /** Fractional frame index of contact. */
  contactFrame: number | null;
  contactConfidence: number;
  /** Which cues agreed on the contact instant. */
  contactCues: Array<{ id: string; frame: number | null; weight: number }>;
  /** Named events other layers depend on. */
  events: Partial<Record<string, number>>;
  signals: Record<string, Array<number | null>>;
}

/**
 * Tolerance the contact instant is judged against, in seconds.
 * Set by the smallest timing difference the analysis has to resolve, not by
 * what happens to be achievable.
 */
export const CONTACT_TOLERANCE_S = 0.02;

const SERVE_LABELS: Record<ServePhaseId, string> = {
  preparation: "Vorbereitung",
  toss: "Ballwurf",
  loading: "Ladephase",
  leg_drive: "Beinantrieb",
  racquet_drop: "Racket Drop",
  acceleration: "Beschleunigung",
  contact: "Treffpunkt",
  follow_through: "Ausschwung / Pronation",
  landing: "Landung & Recovery",
};

const GROUNDSTROKE_LABELS: Record<GroundstrokePhaseId, string> = {
  ready: "Ausgangsstellung",
  unit_turn: "Unit Turn",
  backswing: "Ausholbewegung",
  loading: "Ladephase",
  forward_swing: "Vorwärtsschwung",
  contact: "Treffpunkt",
  follow_through: "Ausschwung",
  recovery: "Recovery",
};

export interface SegmentationOptions {
  stroke: StrokeType;
  hand: Handedness;
  dtScene: number;
  times: number[];
  racket: RacketFrame[];
  /** Contact frame suggested by the ball track, if any. */
  ballContactFrame: number | null;
  ballContactConfidence: number;
  /** Ball position in the image, per frame, for the proximity cue. */
  ballImage?: Array<{ x: number; y: number } | null>;
  /** Racket-head position in the image, per frame. */
  racketImage?: Array<{ x: number; y: number } | null>;
}

export function segment(poses: Pose3D[], opts: SegmentationOptions): SegmentationResult {
  const n = poses.length;
  const side = dominantSide(opts.hand);
  const off = otherSide(side);
  const notes: string[] = [];

  const jointZ = (j: Joint) => poses.map((p) => p[j]?.p.z ?? null);
  const at = (i: number, j: Joint) => poses[i]?.[j] ?? null;

  // --- Signals ----------------------------------------------------------
  const kneeAngle = poses.map((p, i) => {
    const front = opts.stroke === "serve" ? off : off;
    const hip = p[sided("hip", front)];
    const knee = p[sided("knee", front)];
    const ankle = p[sided("ankle", front)];
    if (!hip || !knee || !ankle) return null;
    const a = angle3(hip.p, knee.p, ankle.p);
    return a === null ? null : 180 - a; // flexion, 0 = straight
  });

  const pelvisZ = jointZ("pelvis");
  const racketZ = opts.racket.map((r) => r.head?.z ?? null);
  const wristZ = jointZ(sided("wrist", side));
  const offWristZ = jointZ(sided("wrist", off));
  const elbowAngle = poses.map((p) => {
    const sh = p[sided("shoulder", side)];
    const el = p[sided("elbow", side)];
    const wr = p[sided("wrist", side)];
    if (!sh || !el || !wr) return null;
    return angle3(sh.p, el.p, wr.p);
  });
  // --- Contact ----------------------------------------------------------
  // Contact is located in two stages. First a coarse anchor from the cue that
  // is least likely to be ambiguous, then a refinement using only the cues that
  // agree with it. The reason is that several otherwise good cues are
  // degenerate over the whole clip but sharp locally: arm extension, for
  // instance, is maximal at contact *and* again during the follow-through, so
  // searching it globally is a coin flip while searching it near the anchor is
  // reliable.
  const cues: Array<{ id: string; frame: number | null; weight: number }> = [];

  const filled = (xs: Array<number | null>): number[] => {
    const out: number[] = [];
    const known = xs.filter((x): x is number => x !== null && Number.isFinite(x));
    let last = known[0] ?? 0;
    for (const x of xs) {
      if (x !== null && Number.isFinite(x)) last = x;
      out.push(last);
    }
    return smooth(out, 1);
  };

  const rz = filled(racketZ);
  const racketApex = refinedPeak(rz);
  const ballCue = opts.ballContactFrame;

  // Ball-racket proximity: the most direct evidence there is, when both objects
  // are tracked. Measured in the image, where both are actually observed,
  // rather than in the reconstruction where both carry depth uncertainty.
  let proximityFrame: number | null = null;
  let proximityQuality = 0;
  {
    // Restricted to the frames in which the racket is high. During the toss the
    // ball passes close to the racket *in the image* while being a metre away
    // in space, and an unrestricted search finds that crossing instead of the
    // real contact — a projection artefact that no amount of detector quality
    // would fix.
    const zLow = Math.min(...rz);
    const zHigh = Math.max(...rz);
    const zGate = zLow + 0.72 * (zHigh - zLow);
    let best = Number.POSITIVE_INFINITY;
    let secondBest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const ball = opts.ballImage?.[i];
      const headImage = opts.racketImage?.[i];
      if (!headImage || !ball || rz[i] < zGate) continue;
      const d = Math.hypot(headImage.x - ball.x, headImage.y - ball.y);
      if (d < best) {
        secondBest = best;
        best = d;
        proximityFrame = i;
      } else if (d < secondBest) {
        secondBest = d;
      }
    }
    void secondBest;
    if (proximityFrame !== null && Number.isFinite(best)) {
      // Within a racket-head radius the two are touching; further away the cue
      // degrades smoothly rather than being discarded.
      proximityQuality = clamp(1 - best / 220, 0, 1) * 0.85;
    }
  }

  const anchor =
    ballCue !== null && opts.ballContactConfidence > 0.4
      ? ballCue
      : proximityFrame !== null && proximityQuality > 0.4
        ? proximityFrame
        : racketApex
          ? racketApex.index
          : null;

  const windowFrames = Math.max(4, Math.round(0.16 / opts.dtScene));
  const localPeak = (xs: number[], sign: 1 | -1): number | null => {
    if (anchor === null) return null;
    const lo = Math.max(0, Math.round(anchor) - windowFrames);
    const hi = Math.min(xs.length - 1, Math.round(anchor) + windowFrames);
    if (hi - lo < 2) return null;
    const pk = refinedPeak(xs.slice(lo, hi + 1).map((v) => sign * v));
    return pk ? pk.index + lo : null;
  };

  cues.push({ id: "Ball: Geschwindigkeitssprung", frame: ballCue, weight: opts.ballContactConfidence });
  cues.push({ id: "Ball am Schlägerkopf", frame: proximityFrame, weight: proximityQuality });
  cues.push({
    id: "Höchster Punkt des Schlägerkopfs",
    frame: racketApex ? racketApex.index : null,
    weight: opts.stroke === "serve" && racketZ.filter((v) => v !== null).length > n * 0.5 ? 0.55 : 0.1,
  });

  const handToShoulder = poses.map((p, i) => {
    const sh = p[sided("shoulder", side)];
    const head = opts.racket[i]?.head;
    if (!sh || !head) return null;
    return norm3(sub3(head, sh.p));
  });
  const reachFrame = localPeak(filled(handToShoulder), 1);
  cues.push({
    id: "Maximale Armstreckung",
    frame: reachFrame,
    weight: handToShoulder.filter((v) => v !== null).length > n * 0.5 ? 0.6 : 0.15,
  });

  const racketSpeed = opts.racket.map((r) => r.headSpeedMs);
  if (racketSpeed.filter((v) => v !== null).length > n * 0.4) {
    cues.push({ id: "Spitzengeschwindigkeit Schlägerkopf", frame: localPeak(filled(racketSpeed), 1), weight: 0.45 });
  }

  const usable = cues.filter((c) => c.frame !== null && c.weight > 0.15);
  let contactFrame: number | null = null;
  let contactConfidence = 0;

  if (usable.length > 0) {
    // Consensus with outlier rejection, not a weighted mean.
    //
    // The cues are independent and mostly right, but each has its own way of
    // being badly wrong: the ball detector locks onto the toss apex, the racket
    // vanishes into motion blur, the arm reaches full extension a frame late.
    // A weighted mean lets one confidently wrong cue drag the contact instant
    // by ten frames, and the contact instant is the reference point for every
    // timing measurement in the report.
    const centre = weightedMedian(usable.map((c) => ({ x: c.frame as number, w: c.weight })));
    const spread = median(usable.map((c) => Math.abs((c.frame as number) - centre))) ?? 0;
    const tolerance = Math.max(3, 2.5 * spread);
    const agreeing = usable.filter((c) => Math.abs((c.frame as number) - centre) <= tolerance);
    const dropped = usable.filter((c) => Math.abs((c.frame as number) - centre) > tolerance);

    const kept = agreeing.length > 0 ? agreeing : usable;
    const wsum = kept.reduce((acc, c) => acc + c.weight, 0);
    contactFrame = kept.reduce((acc, c) => acc + (c.frame as number) * c.weight, 0) / wsum;

    const residual =
      kept.length > 1
        ? Math.sqrt(
            kept.reduce(
              (acc, c) => acc + c.weight * ((c.frame as number) - (contactFrame as number)) ** 2,
              0,
            ) / wsum,
          )
        : 6;
    // Confidence is a probability, not a score: the chance that the contact
    // instant is within the tolerance that actually matters. That tolerance is
    // set by what the contact instant is *for* — the inter-segment timing
    // differences the kinetic-chain analysis has to resolve are around 18 ms,
    // so being right to within 20 ms is the thing worth being confident about.
    //
    // A single cue is capped separately. One cue can be right, but it cannot be
    // checked, and an unchecked contact instant silently invalidates every
    // timing measurement that references it.
    const standardErrorS = (residual / Math.sqrt(Math.max(1, kept.length))) * opts.dtScene;
    const withinTolerance =
      standardErrorS > 0 ? 2 * normalCdf(CONTACT_TOLERANCE_S / standardErrorS) - 1 : 1;
    const verifiability = kept.length >= 3 ? 1 : kept.length === 2 ? 0.8 : 0.5;
    contactConfidence = clamp(withinTolerance * verifiability, 0, 0.95);
    if (dropped.length > 0) {
      notes.push(
        `${dropped.length} Treffpunkt-Indiz(ien) wichen stark von den übrigen ab und wurden verworfen ` +
          `(${dropped.map((c) => c.id).join(", ")}).`,
      );
    }
    if (residual > 3) {
      notes.push(
        `Die verbleibenden Treffpunkt-Indizien streuen um ±${residual.toFixed(1)} Bilder — ` +
          "der Treffpunkt ist nicht scharf bestimmt.",
      );
    }
  } else {
    notes.push("Kein Treffpunkt bestimmbar: weder Ball noch Schläger liefern ein auswertbares Signal.");
  }

  // --- Events -----------------------------------------------------------
  const events: Record<string, number> = {};
  const kf = filled(kneeAngle);
  const maxKnee = refinedPeak(kf);
  if (maxKnee) events.maxKneeFlexion = maxKnee.index;

  const pz = filled(pelvisZ);
  const minPelvis = refinedPeak(pz.map((v) => -v));
  if (minPelvis) events.lowestPelvis = minPelvis.index;

  const minRacket = refinedPeak(rz.map((v) => -v));
  if (minRacket && contactFrame !== null && minRacket.index < contactFrame) {
    events.racketLow = minRacket.index;
  } else if (contactFrame !== null) {
    // Constrain the search to the window before contact: the follow-through low
    // point is deeper but is not the racket drop.
    const window = rz.slice(0, Math.max(2, Math.floor(contactFrame)));
    const p = refinedPeak(window.map((v) => -v));
    if (p) events.racketLow = p.index;
  }

  const offWrist = filled(offWristZ);
  const tossPeak = refinedPeak(offWrist);
  if (tossPeak) events.tossArmPeak = tossPeak.index;

  const ea = filled(elbowAngle);
  if (contactFrame !== null) {
    const after = ea.slice(Math.ceil(contactFrame));
    const p = refinedPeak(after.map((v) => -v));
    if (p) events.followThroughElbow = p.index + Math.ceil(contactFrame);
  }

  // --- Phases -----------------------------------------------------------
  const timeAt = (frame: number): number => sampleAt(opts.times, frame) ?? frame * opts.dtScene;
  const phases: Phase[] = [];
  const push = (id: PhaseId, label: string, a: number, b: number, confidence: number) => {
    const s = clamp(a, 0, n - 1);
    const e = clamp(b, 0, n - 1);
    if (e <= s) return;
    phases.push({
      id,
      label,
      startFrame: s,
      endFrame: e,
      startS: timeAt(s),
      endS: timeAt(e),
      confidence: clamp(confidence, 0, 1),
    });
  };

  if (contactFrame === null) {
    return {
      report: {
        id: "L9",
        name: "Bewegungssegmentierung",
        status: "failed",
        quality: 0,
        notes,
        diagnostics: { treffpunktBild: null, phasen: 0 },
      },
      phases: [],
      contactFrame: null,
      contactConfidence: 0,
      contactCues: cues,
      events,
      signals: { kneeAngle, pelvisZ, racketZ, wristZ, elbowAngle },
    };
  }

  const cf = contactFrame;
  if (opts.stroke === "serve") {
    const load = events.maxKneeFlexion ?? cf - 0.34 / opts.dtScene;
    const drop = events.racketLow ?? cf - 0.13 / opts.dtScene;
    const toss = events.tossArmPeak ?? load - 0.25 / opts.dtScene;
    const driveEnd = (load + drop) / 2;
    const half = 0.5;
    const followEnd = events.followThroughElbow ?? cf + 0.25 / opts.dtScene;

    push("preparation", SERVE_LABELS.preparation, 0, Math.min(toss, load), 0.5);
    push("toss", SERVE_LABELS.toss, Math.min(toss, load), load, tossPeak ? 0.55 : 0.3);
    push("loading", SERVE_LABELS.loading, load, driveEnd, maxKnee ? 0.8 : 0.35);
    push("leg_drive", SERVE_LABELS.leg_drive, driveEnd, drop, minPelvis ? 0.65 : 0.35);
    push("racquet_drop", SERVE_LABELS.racquet_drop, drop, cf - 0.045 / opts.dtScene, events.racketLow !== undefined ? 0.75 : 0.3);
    push("acceleration", SERVE_LABELS.acceleration, cf - 0.045 / opts.dtScene, cf - half, contactConfidence * 0.9);
    push("contact", SERVE_LABELS.contact, cf - half, cf + half, contactConfidence);
    push("follow_through", SERVE_LABELS.follow_through, cf + half, followEnd, contactConfidence * 0.85);
    push("landing", SERVE_LABELS.landing, followEnd, n - 1, 0.5);
  } else {
    const load = events.maxKneeFlexion ?? cf - 0.25 / opts.dtScene;
    const back = events.racketLow ?? cf - 0.35 / opts.dtScene;
    const half = 0.5;
    push("ready", GROUNDSTROKE_LABELS.ready, 0, Math.min(back, load) - 0.15 / opts.dtScene, 0.4);
    push("unit_turn", GROUNDSTROKE_LABELS.unit_turn, Math.min(back, load) - 0.15 / opts.dtScene, back, 0.45);
    push("backswing", GROUNDSTROKE_LABELS.backswing, back, load, 0.55);
    push("loading", GROUNDSTROKE_LABELS.loading, load, cf - 0.12 / opts.dtScene, maxKnee ? 0.7 : 0.35);
    push("forward_swing", GROUNDSTROKE_LABELS.forward_swing, cf - 0.12 / opts.dtScene, cf - half, contactConfidence * 0.9);
    push("contact", GROUNDSTROKE_LABELS.contact, cf - half, cf + half, contactConfidence);
    push("follow_through", GROUNDSTROKE_LABELS.follow_through, cf + half, cf + 0.25 / opts.dtScene, contactConfidence * 0.8);
    push("recovery", GROUNDSTROKE_LABELS.recovery, cf + 0.25 / opts.dtScene, n - 1, 0.4);
  }

  const quality = clamp(
    contactConfidence * 0.6 + (mean(phases.map((p) => p.confidence)) ?? 0) * 0.4,
    0,
    1,
  );

  return {
    report: {
      id: "L9",
      name: "Bewegungssegmentierung",
      status: quality > 0.6 ? "ok" : quality > 0.3 ? "degraded" : "failed",
      quality,
      notes,
      diagnostics: {
        treffpunktBild: Number(cf.toFixed(2)),
        treffpunktSicherheit: Number(contactConfidence.toFixed(2)),
        indizien: usable.length,
        phasen: phases.length,
      },
    },
    phases,
    contactFrame: cf,
    contactConfidence,
    contactCues: cues,
    events,
    signals: { kneeAngle, pelvisZ, racketZ, wristZ, elbowAngle },
  };
}

/** Weighted median: the value at which half the weight lies on either side. */
function weightedMedian(points: Array<{ x: number; w: number }>): number {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p.w;
    if (acc >= total / 2) return p.x;
  }
  return sorted[sorted.length - 1].x;
}

/** Derivative helper shared with the feature layer. */
export const rateOf = (xs: number[], dt: number): number[] => derivative(xs, dt);

