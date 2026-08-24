import test from "node:test";
import assert from "node:assert/strict";

import { analyse } from "../src/pipeline.ts";
import { buildScenario, GOOD_CAPTURE } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS, generateServe } from "../src/fixtures/serve-model.ts";
import { CAMERA_RIGS, cameraFromRig } from "../src/fixtures/render.ts";
import { project } from "../src/core/camera.ts";
import { clamp, type Vec2 } from "../src/core/math.ts";
import type { Joint } from "../src/core/types.ts";
import { metric } from "./helpers.ts";

/**
 * What the existing tool does, and why it produces the Sinner result.
 *
 * `legacyServeScore` below is the shipped algorithm, transcribed from the
 * production bundle of Baseline Pro. A coach marks two key frames and clicks
 * joints on them; the app computes four angles from those image points, scores
 * each against a published mean and standard deviation, and averages the four
 * scores into a similarity out of ten.
 *
 * The tests here feed it the *best case it could ever see*: a world-class serve
 * whose joint positions are known exactly, clicked with zero error, on the
 * correct frames, by a coach who never mis-identifies a landmark. Every
 * remaining error is therefore inherent to the method rather than to the user.
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

const LEGACY_REFERENCES = {
  trunkIncl: { mean: 25.0, sd: 7.1, label: "Rumpfneigung (Trophy)" },
  kneeFlex: { mean: 64.5, sd: 9.7, label: "Vordere Knieflexion (Trophy)" },
  shoulderElev: { mean: 110.7, sd: 16.9, label: "Schulterelevation (Kontakt)" },
  elbowFlex: { mean: 30.1, sd: 15.9, label: "Ellbogenflexion (Kontakt)" },
} as const;

/** The tool's similarity curve, verbatim. */
function legacySimilarity(value: number, mean: number, sd: number): { z: number; score: number } {
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
  angles: Record<keyof typeof LEGACY_REFERENCES, number>;
  scores: Record<keyof typeof LEGACY_REFERENCES, number>;
  zs: Record<keyof typeof LEGACY_REFERENCES, number>;
  overall: number;
}

/**
 * Runs the legacy algorithm on a known serve, with perfect digitising.
 * `rig` selects the camera; `hand` is assumed right.
 */
function legacyServeScore(rigName: keyof typeof CAMERA_RIGS, presetName: keyof typeof SERVE_PRESETS): LegacyResult {
  const truth = generateServe(SERVE_PRESETS[presetName], 240);
  const cam = cameraFromRig(CAMERA_RIGS[rigName]);

  // The two key frames the tool asks for, located on ground truth rather than
  // by eye — again, better than any coach could do.
  const kneeSeries = truth.frames.map((f) => f.dof.kneeFlexDeg);
  const trophyIndex = kneeSeries.indexOf(Math.max(...kneeSeries));
  const contactIndex = Math.round(SERVE_PRESETS[presetName].contactT * 240);

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
    trunkIncl: inclinationFromVertical(
      mid(trophy.shFront, trophy.shBack),
      mid(trophy.hipFront, trophy.hipBack),
    ),
    kneeFlex: 180 - angle2D(trophy.hipFront, trophy.kneeFront, trophy.ankleFront),
    shoulderElev: angle2D(impact.hipHit, impact.shHit, impact.elbow),
    elbowFlex: 180 - angle2D(impact.shHit, impact.elbow, impact.wrist),
  };

  const scores = {} as LegacyResult["scores"];
  const zs = {} as LegacyResult["zs"];
  for (const key of Object.keys(LEGACY_REFERENCES) as Array<keyof typeof LEGACY_REFERENCES>) {
    const r = LEGACY_REFERENCES[key];
    const sim = legacySimilarity(angles[key], r.mean, r.sd);
    scores[key] = sim.score;
    zs[key] = sim.z;
  }
  const overall = Object.values(scores).reduce((s, v) => s + v, 0) / 4;
  return { angles, scores, zs, overall };
}

/* ------------------------------------------------------------------ */

test("the legacy method rates a world-class serve as mediocre, from perfect input", () => {
  // This is the Sinner case, reproduced. No tracking error, no clicking error,
  // no wrong frame: a flawless digitisation of an elite serve.
  const results = (["side", "diagonal", "behind", "front", "elevatedSide"] as const).map((rig) => ({
    rig,
    ...legacyServeScore(rig, "elite"),
  }));

  const worst = results.reduce((a, b) => (a.overall <= b.overall ? a : b));
  const best = results.reduce((a, b) => (a.overall >= b.overall ? a : b));

  assert.ok(
    worst.overall < 6.5,
    `the legacy method was expected to under-rate an elite serve; worst camera gave ` +
      `${worst.overall.toFixed(1)}/10 (${worst.rig})`,
  );

  // And the failure is not a constant offset that could be calibrated away: the
  // same stroke scores differently depending only on where the camera stood.
  assert.ok(
    best.overall - worst.overall > 1.5,
    `the legacy score should swing with camera placement; got ${worst.overall.toFixed(1)} to ` +
      `${best.overall.toFixed(1)}`,
  );
});

test("the legacy angles differ from the 3D angles they are compared against", () => {
  // The mechanism, isolated. A projected angle is not the anatomical angle, and
  // the difference is large compared with the spread of the reference
  // distribution the tool scores against.
  const params = SERVE_PRESETS.elite;
  const truth = generateServe(params, 240);
  const contactIndex = Math.round(params.contactT * 240);
  const trueElbowFlexion = truth.frames[contactIndex].dof.elbowFlexDeg;

  const projectedByRig = (["side", "diagonal", "behind", "front"] as const).map(
    (rig) => legacyServeScore(rig, "elite").angles.elbowFlex,
  );

  const worstError = Math.max(...projectedByRig.map((v) => Math.abs(v - trueElbowFlexion)));
  assert.ok(
    worstError > LEGACY_REFERENCES.elbowFlex.sd,
    `projection error on elbow flexion (${worstError.toFixed(1)} deg) should exceed the reference ` +
      `spread it is scored against (${LEGACY_REFERENCES.elbowFlex.sd} deg)`,
  );
});

test("the new pipeline does not repeat the failure on the same serve", () => {
  const scenario = buildScenario("legacy-vs-new", "Weltklasse", {
    preset: "elite",
    level: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
    render: GOOD_CAPTURE,
  });
  const { report } = analyse(scenario.request, {
    now: "2026-08-24T00:00:00Z",
    depthPrior: scenario.depthPrior,
  });

  // Either it declines to judge, or it judges well. What it must never do is
  // call an elite serve poor.
  if (report.verdict.kind === "assessment") {
    assert.ok(
      (report.verdict.score ?? 0) >= 70,
      `an elite serve was scored ${report.verdict.score}/100 by the new pipeline`,
    );
  }

  // And the measurement it makes of the same elbow angle must be close to the
  // truth, with an interval that covers it.
  const truth = generateServe(SERVE_PRESETS.elite, 480);
  const trueElbow = truth.frames[Math.round(SERVE_PRESETS.elite.contactT * 480)].dof.elbowFlexDeg;
  const m = metric(report, "elbowFlexionAtContact");
  assert.ok(m && m.value !== null && m.interval95, "elbow flexion at contact should be measured");
  const [lo, hi] = m!.interval95 as [number, number];
  assert.ok(
    trueElbow >= lo && trueElbow <= hi,
    `true elbow flexion ${trueElbow.toFixed(1)} deg outside the reported interval ` +
      `[${lo.toFixed(1)}, ${hi.toFixed(1)}]`,
  );
});
