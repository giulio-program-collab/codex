import { clamp, mean } from "../core/math.ts";
import { TRUNK_LANDMARK_FRACTION } from "../fixtures/anthropometry.ts";
import {
  JOINTS,
  JOINT_SOURCE,
  type FrameObservation,
  type Joint,
  type LayerReport,
  type Pose2D,
} from "../core/types.ts";

/**
 * Layer 4 — Pose estimation adapter.
 *
 * Detectors emit their own joint sets (COCO-17, Halpe-26, SMPL vertices). This
 * layer maps whatever arrives onto the tennis skeleton, keeps the detector's
 * own score for every joint, and — importantly — refuses to invent the joints
 * the detector never saw. Derived joints (pelvis, thorax, sternum, neck) are
 * constructed here from observed ones, and each carries a reduced confidence
 * that says so.
 */

export interface PoseLayerResult {
  report: LayerReport;
  frames: FrameObservation[];
  /** Mean detector score per joint over the clip; the per-segment quality view. */
  perJointScore: Partial<Record<Joint, number>>;
  /** Fraction of frames in which the joint was present at all. */
  perJointCoverage: Partial<Record<Joint, number>>;
}

/** Confidence penalty applied to joints the detector never observes directly. */
const DERIVED_PENALTY = 0.85;

/**
 * Cervicale above the acromion midpoint, as a fraction of the hip-to-shoulder
 * distance: (0.870 - 0.818) / (0.818 - 0.530) from Winter's stature fractions.
 */
export const NECK_ABOVE_STERNUM = (0.87 - 0.818) / (0.818 - 0.53);

export function adaptPoses(frames: FrameObservation[]): PoseLayerResult {
  const out: FrameObservation[] = frames.map((f) => ({ ...f, pose2d: completeSkeleton(f.pose2d) }));

  const perJointScore: Partial<Record<Joint, number>> = {};
  const perJointCoverage: Partial<Record<Joint, number>> = {};
  for (const j of JOINTS) {
    const scores: number[] = [];
    let present = 0;
    for (const f of out) {
      const kp = f.pose2d[j];
      if (kp) {
        present++;
        scores.push(kp.score);
      }
    }
    perJointScore[j] = scores.length ? clamp(mean(scores) ?? 0, 0, 1) : 0;
    perJointCoverage[j] = out.length ? present / out.length : 0;
  }

  const notes: string[] = [];
  const weak = JOINTS.filter((j) => (perJointCoverage[j] ?? 0) < 0.6);
  if (weak.length) {
    notes.push(`Unzureichend erkannt (<60 % der Bilder): ${weak.join(", ")}.`);
  }
  const observed = JOINTS.filter((j) => JOINT_SOURCE[j] === "observed");
  const quality = clamp(
    mean(observed.map((j) => (perJointCoverage[j] ?? 0) * (perJointScore[j] ?? 0))) ?? 0,
    0,
    1,
  );

  return {
    report: {
      id: "L4",
      name: "Pose-Estimation",
      status: quality > 0.7 ? "ok" : quality > 0.4 ? "degraded" : "failed",
      quality,
      notes,
      diagnostics: {
        mittlereGelenkguete: Number(quality.toFixed(3)),
        schwacheGelenke: weak.length,
      },
    },
    frames: out,
    perJointScore,
    perJointCoverage,
  };
}

/**
 * Builds the derived trunk joints from observed shoulders and hips.
 * Nothing is invented where the inputs are missing: the derived joint is simply
 * absent, and every downstream metric that needs it reports "not measurable".
 */
export function completeSkeleton(pose: Pose2D): Pose2D {
  const out: Pose2D = { ...pose };
  const midpoint = (a: Joint, b: Joint): { p: { x: number; y: number }; score: number } | null => {
    const ka = out[a];
    const kb = out[b];
    if (!ka || !kb) return null;
    return {
      p: { x: (ka.p.x + kb.p.x) / 2, y: (ka.p.y + kb.p.y) / 2 },
      score: Math.min(ka.score, kb.score) * DERIVED_PENALTY,
    };
  };

  const shoulderMid = midpoint("shoulderL", "shoulderR");
  const hipMid = midpoint("hipL", "hipR");

  if (hipMid && !out.pelvis) out.pelvis = { ...hipMid };
  if (shoulderMid && !out.sternum) out.sternum = { ...shoulderMid };
  if (shoulderMid && !out.neck) {
    // Cervicale sits a little above the acromion midpoint; the offset is taken
    // along the trunk axis so it survives any body orientation.
    if (hipMid) {
      // Cervicale sits above the acromion midpoint by (neck height - shoulder
      // height), which is 0.052 of stature in Winter's table, i.e. 0.194 of the
      // hip-to-shoulder distance. The constant has to agree with the bone
      // length the reconstruction expects for `neck-sternum`, or every frame
      // will be rejected as anatomically impossible.
      const dx = shoulderMid.p.x - hipMid.p.x;
      const dy = shoulderMid.p.y - hipMid.p.y;
      out.neck = {
        p: { x: shoulderMid.p.x + dx * NECK_ABOVE_STERNUM, y: shoulderMid.p.y + dy * NECK_ABOVE_STERNUM },
        score: shoulderMid.score,
      };
    } else {
      out.neck = { ...shoulderMid };
    }
  }
  if (shoulderMid && hipMid) {
    const lerp = (t: number) => ({
      p: {
        x: hipMid.p.x + (shoulderMid.p.x - hipMid.p.x) * t,
        y: hipMid.p.y + (shoulderMid.p.y - hipMid.p.y) * t,
      },
      score: Math.min(shoulderMid.score, hipMid.score) * DERIVED_PENALTY,
    });
    if (!out.spine) out.spine = lerp(TRUNK_LANDMARK_FRACTION.spine);
    if (!out.thorax) out.thorax = lerp(TRUNK_LANDMARK_FRACTION.thorax);
  }

  // Hand centres: a short extension of the forearm. Real detectors that emit
  // hands should override this; the fallback keeps the racket-grip anchor
  // available with an honest confidence penalty.
  for (const side of ["L", "R"] as const) {
    const elbow = out[`elbow${side}` as Joint];
    const wrist = out[`wrist${side}` as Joint];
    const handKey = `hand${side}` as Joint;
    if (elbow && wrist && !out[handKey]) {
      const dx = wrist.p.x - elbow.p.x;
      const dy = wrist.p.y - elbow.p.y;
      out[handKey] = {
        p: { x: wrist.p.x + dx * 0.28, y: wrist.p.y + dy * 0.28 },
        score: wrist.score * DERIVED_PENALTY,
      };
    }
  }
  return out;
}
