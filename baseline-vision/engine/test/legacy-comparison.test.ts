import test from "node:test";
import assert from "node:assert/strict";

import { analyse } from "../src/pipeline.ts";
import { buildScenario, GOOD_CAPTURE } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS, generateServe } from "../src/fixtures/serve-model.ts";
import { LEGACY_REFERENCES, legacyServeScore } from "../src/legacy/legacy-2d.ts";
import { metric } from "./helpers.ts";

/**
 * What the existing tool does, and why it produces the Sinner result.
 *
 * The algorithm itself lives in `src/legacy/legacy-2d.ts`, transcribed from the
 * production bundle of Baseline Pro, so that the tests here and the playground
 * run the very same code. These tests feed it the *best case it could ever
 * see*: a world-class serve whose joint positions are known exactly, clicked
 * with zero error, on the correct frames, by a coach who never mis-identifies a
 * landmark. Every remaining error is therefore inherent to the method rather
 * than to the user.
 */

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
