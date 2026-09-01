import { project } from "../core/camera.ts";
import { clamp, type Vec2 } from "../core/math.ts";
import { CAMERA_RIGS, cameraFromRig } from "../fixtures/render.ts";
import { SERVE_PRESETS, generateServe, type ServeParams, type ServeTruth } from "../fixtures/serve-model.ts";
import type { Joint } from "../core/types.ts";

/**
 * The algorithm the old tool shipped, kept as a reference implementation.
 *
 * This is not part of the pipeline and nothing imports it into the pipeline. It
 * exists so the defect it produces can be reproduced on demand — by the
 * regression tests, and by the playground, where a coach can watch the two
 * methods disagree about the same stroke.
 *
 * A coach marks two key frames and clicks joints on them; the app computes four
 * angles from those image points, scores each against a published mean and
 * standard deviation, and averages the four scores into a similarity out of ten.
 *
 * The reference values and the scoring curve are quoted from the tool itself:
 *
 *   trunk inclination at trophy   25.0 +/- 7.1 deg
 *   front knee flexion at trophy  64.5 +/- 9.7 deg
 *   shoulder elevation at contact 110.7 +/- 16.9 deg
 *   elbow flexion at contact      30.1 +/- 15.9 deg
 *   score(z) = clamp(0, 10, 10 * exp(-z^2 / 8))
 *
 * All four come from three-dimensional laboratory kinematics — the Frontiers in
 * Sports and Active Living 2024 meta-analysis, ISB-normalised, from multi-camera
 * marker systems. The tool compares them against angles measured in the image
 * plane. Those are not the same quantity, and the gap between them is the
 * defect.
 */

export const LEGACY_REFERENCES = {
  trunkIncl: { mean: 25.0, sd: 7.1, label: "Rumpfneigung (Trophy)" },
  kneeFlex: { mean: 64.5, sd: 9.7, label: "Vordere Knieflexion (Trophy)" },
  shoulderElev: { mean: 110.7, sd: 16.9, label: "Schulterelevation (Kontakt)" },
  elbowFlex: { mean: 30.1, sd: 15.9, label: "Ellbogenflexion (Kontakt)" },
} as const;

export type LegacyAngleId = keyof typeof LEGACY_REFERENCES;

/** The tool's similarity curve, verbatim. */
export function legacySimilarity(value: number, mean: number, sd: number): { z: number; score: number } {
  const z = (value - mean) / sd;
  return { z, score: clamp(10 * Math.exp(-(z * z) / 8), 0, 10) };
}

/** Interior angle A-B-C, measured in the image plane. */
function angle2D(a: Vec2, b: Vec2, c: Vec2): number {
  const u = { x: a.x - b.x, y: a.y - b.y };
  const w = { x: c.x - b.x, y: c.y - b.y };
  const nu = Math.hypot(u.x, u.y);
  const nw = Math.hypot(w.x, w.y);
  if (nu < 1e-9 || nw < 1e-9) return 0;
  return (Math.acos(clamp((u.x * w.x + u.y * w.y) / (nu * nw), -1, 1)) * 180) / Math.PI;
}

/** Inclination of a line from image vertical, as the tool computes it. */
function inclinationFromVertical(top: Vec2, bottom: Vec2): number {
  return Math.abs((Math.atan2(top.x - bottom.x, bottom.y - top.y) * 180) / Math.PI);
}

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export interface LegacyResult {
  angles: Record<LegacyAngleId, number>;
  scores: Record<LegacyAngleId, number>;
  zs: Record<LegacyAngleId, number>;
  overall: number;
  /** True three-dimensional values of the same four quantities, for contrast. */
  truthAngles: Record<LegacyAngleId, number>;
}

/**
 * Runs the legacy algorithm on a known serve, with perfect digitising: exact
 * joint positions, the correct key frames, no clicking error. Every remaining
 * error is therefore inherent to the method rather than to the user.
 */
export function legacyServeScore(
  rigName: keyof typeof CAMERA_RIGS,
  preset: keyof typeof SERVE_PRESETS | ServeParams,
  precomputed?: ServeTruth,
): LegacyResult {
  const params: ServeParams = typeof preset === "object" ? preset : SERVE_PRESETS[preset];
  const truth = precomputed ?? generateServe(params, 240);
  const cam = cameraFromRig(CAMERA_RIGS[rigName]);

  // The two key frames the tool asks for, located on ground truth rather than
  // by eye — again, better than any coach could do.
  const kneeSeries = truth.frames.map((f) => f.dof.kneeFlexDeg);
  const trophyIndex = kneeSeries.indexOf(Math.max(...kneeSeries));
  const dt = truth.frames[1].t - truth.frames[0].t;
  const contactIndex = Math.min(truth.frames.length - 1, Math.max(0, Math.round(params.contactT / dt)));

  const at = (index: number, joint: Joint): Vec2 => project(cam, truth.frames[index].joints[joint]).p;

  const trophy = {
    shFront: at(trophyIndex, "shoulderL"),
    shBack: at(trophyIndex, "shoulderR"),
    hipFront: at(trophyIndex, "hipL"),
    hipBack: at(trophyIndex, "hipR"),
    kneeFront: at(trophyIndex, "kneeL"),
    ankleFront: at(trophyIndex, "ankleL"),
  };
  const impact = {
    shHit: at(contactIndex, "shoulderR"),
    elbow: at(contactIndex, "elbowR"),
    wrist: at(contactIndex, "wristR"),
    hipHit: at(contactIndex, "hipR"),
  };

  const angles = {
    trunkIncl: inclinationFromVertical(mid(trophy.shFront, trophy.shBack), mid(trophy.hipFront, trophy.hipBack)),
    kneeFlex: 180 - angle2D(trophy.hipFront, trophy.kneeFront, trophy.ankleFront),
    shoulderElev: angle2D(impact.hipHit, impact.shHit, impact.elbow),
    elbowFlex: 180 - angle2D(impact.shHit, impact.elbow, impact.wrist),
  };

  const scores = {} as LegacyResult["scores"];
  const zs = {} as LegacyResult["zs"];
  for (const key of Object.keys(LEGACY_REFERENCES) as LegacyAngleId[]) {
    const r = LEGACY_REFERENCES[key];
    const sim = legacySimilarity(angles[key], r.mean, r.sd);
    scores[key] = sim.score;
    zs[key] = sim.z;
  }
  const overall = Object.values(scores).reduce((s, v) => s + v, 0) / 4;

  const truthAngles: Record<LegacyAngleId, number> = {
    trunkIncl: truth.frames[trophyIndex].dof.trunkTiltDeg,
    kneeFlex: truth.frames[trophyIndex].dof.kneeFlexDeg,
    shoulderElev: truth.frames[contactIndex].dof.shoulderElevDeg,
    elbowFlex: truth.frames[contactIndex].dof.elbowFlexDeg,
  };

  return { angles, scores, zs, overall, truthAngles };
}
