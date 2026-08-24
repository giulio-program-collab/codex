import test from "node:test";
import assert from "node:assert/strict";

import { analyse } from "../src/pipeline.ts";
import { buildScenario, GOOD_CAPTURE, PHONE_CAPTURE } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS, generateServe } from "../src/fixtures/serve-model.ts";
import { CAMERA_RIGS, cameraFromRig, renderClip } from "../src/fixtures/render.ts";
import { anthropometryFor, expectedBoneLengths } from "../src/fixtures/anthropometry.ts";
import { REALISTIC_LEARNED_LIFT_SIGMA_M } from "../src/fixtures/simulated-lift.ts";
import { BONES, JOINTS } from "../src/core/types.ts";
import { dist3 } from "../src/core/math.ts";
import { metric } from "./helpers.ts";

/**
 * Validation against ground truth.
 *
 * The synthetic fixtures are not a substitute for annotated real footage — the
 * validation plan in the documentation says exactly what has to be measured on
 * real data before any of this is trusted on a court. What they *are* is a
 * regression harness with known answers, which is the only way to tell a change
 * that improved the pipeline from a change that moved the numbers.
 *
 * Every threshold below is a statement about accuracy the system currently
 * achieves. When one of them fails, either the pipeline got worse or the claim
 * was wrong; both are worth stopping for.
 */

const NOW = "2026-08-24T00:00:00Z";

/* ------------------------------------------------------------------ */
/* The fixture itself must be trustworthy                              */
/* ------------------------------------------------------------------ */

test("the synthetic serve has rigid bones", () => {
  for (const presetName of Object.keys(SERVE_PRESETS)) {
    const truth = generateServe(SERVE_PRESETS[presetName], 240);
    for (const [p, q] of BONES) {
      const lengths = truth.frames.map((f) => dist3(f.joints[p], f.joints[q]));
      const lo = Math.min(...lengths);
      const hi = Math.max(...lengths);
      const variation = (hi - lo) / ((hi + lo) / 2);
      assert.ok(
        variation < 0.01,
        `${presetName}: bone ${p}-${q} varies by ${(variation * 100).toFixed(1)} % over the clip`,
      );
    }
  }
});

test("the synthetic serve matches its own anthropometric table", () => {
  const truth = generateServe(SERVE_PRESETS.elite, 240);
  const expected = expectedBoneLengths(truth.anthro);
  for (const [p, q] of BONES) {
    const L = expected[`${p}-${q}`];
    if (!L) continue;
    const actual = dist3(truth.frames[0].joints[p], truth.frames[0].joints[q]);
    assert.ok(
      Math.abs(actual - L) / L < 0.02,
      `${p}-${q}: fixture builds ${actual.toFixed(3)} m, table expects ${L.toFixed(3)} m`,
    );
  }
});

test("the synthetic serve reproduces the kinematics it claims", () => {
  const params = SERVE_PRESETS.elite;
  const truth = generateServe(params, 480);
  const contactIndex = Math.round(params.contactT * 480);
  const contact = truth.frames[contactIndex];

  assert.ok(Math.abs(contact.dof.elbowFlexDeg - params.elbowFlexAtContactDeg) < 4);
  assert.ok(Math.abs(contact.dof.shoulderElevDeg - params.shoulderElevAtContactDeg) < 8);
  assert.ok(
    Math.abs(Math.max(...truth.frames.map((f) => f.dof.kneeFlexDeg)) - params.kneeFlexPeakDeg) < 2,
  );

  // The commanded rotation-peak timings must actually be where the model puts
  // the peak angular velocities.
  const rate = (values: number[]) =>
    values.map((_, i) =>
      i === 0 || i === values.length - 1 ? 0 : Math.abs((values[i + 1] - values[i - 1]) * 240),
    );
  const pelvisRate = rate(truth.frames.map((f) => f.dof.pelvisYawDeg));
  const trunkRate = rate(truth.frames.map((f) => f.dof.thoraxYawDeg));
  const argmax = (xs: number[]) => xs.indexOf(Math.max(...xs));
  assert.ok(
    Math.abs(argmax(pelvisRate) / 480 - params.contactT - params.pelvisPeakLeadS) < 0.012,
    "pelvis peak is not where the parameter says",
  );
  assert.ok(
    Math.abs(argmax(trunkRate) / 480 - params.contactT - params.trunkPeakLeadS) < 0.012,
    "trunk peak is not where the parameter says",
  );

  // Racket-head speed must be in the range a real serve produces.
  assert.ok(
    truth.peakRacketHeadSpeedMs > 30 && truth.peakRacketHeadSpeedMs < 50,
    `peak racket-head speed ${truth.peakRacketHeadSpeedMs.toFixed(1)} m/s is not plausible for an elite serve`,
  );
});

/* ------------------------------------------------------------------ */
/* Reconstruction accuracy                                             */
/* ------------------------------------------------------------------ */

/**
 * Mean per-joint position error, after removing the root offset and the single
 * best-fit rotation about the vertical.
 *
 * The yaw has to come out: the court frame's "toward the target" axis is
 * estimated from the player's own shoulders and is only good to a few tens of
 * degrees, so leaving it in would measure that estimate rather than the
 * reconstruction. Nothing else is removed — no per-frame alignment, no scale —
 * so the number that survives is the reconstruction's own error.
 */
function meanJointError(
  reconstructed: Array<Record<string, { p: { x: number; y: number; z: number } } | undefined>>,
  truth: ReturnType<typeof generateServe>,
  fps: number,
): number {
  const errorAtYaw = (degrees: number, step: number): number => {
    const c = Math.cos((degrees * Math.PI) / 180);
    const s = Math.sin((degrees * Math.PI) / 180);
    let total = 0;
    let count = 0;
    for (let i = 0; i < reconstructed.length; i += step) {
      const truthIndex = Math.min(truth.frames.length - 1, Math.round((i / fps) * 240));
      const t = truth.frames[truthIndex];
      const root = reconstructed[i]?.pelvis?.p;
      if (!root) continue;
      for (const j of JOINTS) {
        const r = reconstructed[i]?.[j]?.p;
        if (!r) continue;
        const dx = r.x - root.x;
        const dy = r.y - root.y;
        const dz = r.z - root.z;
        const rx = c * dx - s * dy;
        const ry = s * dx + c * dy;
        const tx = t.joints[j].x - t.joints.pelvis.x;
        const ty = t.joints[j].y - t.joints.pelvis.y;
        const tz = t.joints[j].z - t.joints.pelvis.z;
        total += Math.hypot(rx - tx, ry - ty, dz - tz);
        count++;
      }
    }
    return count > 0 ? total / count : Number.POSITIVE_INFINITY;
  };

  let best = Number.POSITIVE_INFINITY;
  let bestYaw = 0;
  for (let d = -180; d < 180; d += 2) {
    const e = errorAtYaw(d, 4);
    if (e < best) {
      best = e;
      bestYaw = d;
    }
  }
  // Refine, then evaluate on every frame.
  for (let d = bestYaw - 2; d <= bestYaw + 2; d += 0.25) {
    const e = errorAtYaw(d, 4);
    if (e < best) {
      best = e;
      bestYaw = d;
    }
  }
  return errorAtYaw(bestYaw, 1);
}

/** Median reconstructed stature, as a 3D distance from head to ankle. */
function reconstructedStatureM(
  poses: Array<Record<string, { p: { x: number; y: number; z: number } } | undefined>>,
): number | null {
  const values: number[] = [];
  for (const pose of poses.slice(0, 40)) {
    const head = pose.head?.p;
    const ankle = pose.ankleL?.p ?? pose.ankleR?.p;
    if (head && ankle) values.push(Math.hypot(head.x - ankle.x, head.y - ankle.y, head.z - ankle.z));
  }
  if (values.length < 6) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

test("body scale is recovered from every camera angle, with or without a depth prior", () => {
  const anthro = anthropometryFor(SERVE_PRESETS.elite.heightCm, "right");
  const expected =
    anthro.neckHeightM + anthro.headAboveNeckM * 0.6 - anthro.ankleHeightM;

  for (const rig of ["side", "diagonal", "elevatedSide", "behind", "front"] as const) {
    for (const learnedDepth of [false, true]) {
      const scenario = buildScenario(`scale-${rig}-${learnedDepth}`, rig, {
        preset: "elite",
        rig,
        fps: 120,
        knownFieldOfView: true,
        learnedDepth,
      });
      const { intermediates } = analyse(scenario.request, {
        now: NOW,
        depthPrior: learnedDepth ? scenario.depthPrior : undefined,
      });
      const stature = reconstructedStatureM(intermediates.poses3d);
      assert.ok(stature !== null, `${rig}: no frame with a full body`);
      const error = Math.abs((stature as number) - expected) / expected;
      // Scale is the one thing the geometric solve does reliably on its own:
      // it comes from bone lengths against projected lengths and does not
      // depend on resolving any depth sign. A depth prior tightens it further.
      const bound = learnedDepth ? 0.05 : 0.15;
      assert.ok(
        error < bound,
        `${rig} (${learnedDepth ? "mit" : "ohne"} Tiefenprior): stature off by ${(error * 100).toFixed(1)} %`,
      );
    }
  }
});

test("a learned depth prior improves reconstruction accuracy, as the architecture claims", () => {
  // The architecture document says the geometric solve is a fallback and that a
  // learned depth model is the production front end. This is that claim, made
  // falsifiable: with a 55 mm depth prior the pipeline must add essentially
  // nothing on top of it, and without one it must do markedly worse.
  const rigs = ["side", "diagonal", "elevatedSide"] as const;
  for (const rig of rigs) {
    const base = { preset: "elite" as const, level: "elite" as const, rig, fps: 240, knownFieldOfView: true };
    const geometric = buildScenario(`geo-${rig}`, "Nur Geometrie", base);
    const learned = buildScenario(`learned-${rig}`, "Mit Tiefenprior", { ...base, learnedDepth: true });

    const geoError = meanJointError(
      analyse(geometric.request, { now: NOW }).intermediates.poses3d,
      geometric.truth,
      240,
    );
    const learnedError = meanJointError(
      analyse(learned.request, { now: NOW, depthPrior: learned.depthPrior }).intermediates.poses3d,
      learned.truth,
      240,
    );

    assert.ok(
      learnedError < geoError,
      `${rig}: the depth prior did not help — geometric ${(geoError * 1000).toFixed(0)} mm, ` +
        `with prior ${(learnedError * 1000).toFixed(0)} mm`,
    );
    assert.ok(
      learnedError < 0.075,
      `${rig}: with a ${Math.round(REALISTIC_LEARNED_LIFT_SIGMA_M * 1000)} mm depth prior the pipeline ` +
        `should stay under 75 mm mean joint error, got ${(learnedError * 1000).toFixed(0)} mm`,
    );
  }
});

test("the geometric fallback reports its own weakness rather than hiding it", () => {
  // Without a depth prior the reconstruction is markedly worse, and the value
  // of the system rests entirely on it saying so. A silent 300 mm error is the
  // failure mode the whole design exists to prevent.
  const scenario = buildScenario("geo-honesty", "Nur Geometrie", {
    preset: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
  });
  const { report, intermediates } = analyse(scenario.request, { now: NOW });
  const error = meanJointError(intermediates.poses3d, scenario.truth, 240);
  const withPrior = buildScenario("geo-honesty-prior", "Mit Tiefenprior", {
    preset: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const priorResult = analyse(withPrior.request, { now: NOW, depthPrior: withPrior.depthPrior });

  if (error > 0.15) {
    const geoReconstruction =
      report.quality.components.find((c) => c.id === "reconstruction")?.score ?? 100;
    const priorReconstruction =
      priorResult.report.quality.components.find((c) => c.id === "reconstruction")?.score ?? 0;
    assert.ok(
      geoReconstruction < priorReconstruction,
      `the geometric run is ${(error * 1000).toFixed(0)} mm out but scores its reconstruction ` +
        `${geoReconstruction} against ${priorReconstruction} with a prior`,
    );
    assert.ok(
      intermediates.mirrorConfidence < 0.6,
      `depth-sign confidence should be low when the geometric solve is ${(error * 1000).toFixed(0)} mm out, ` +
        `got ${intermediates.mirrorConfidence.toFixed(2)}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Event detection accuracy                                            */
/* ------------------------------------------------------------------ */

test("contact is located to within 25 ms, or its confidence says otherwise", () => {
  const rigs = ["side", "diagonal", "elevatedSide"] as const;
  for (const rig of rigs) {
    for (const seed of [3, 11, 23]) {
      const scenario = buildScenario(`contact-${rig}-${seed}`, rig, {
        preset: "elite",
        rig,
        fps: 240,
        seed,
        knownFieldOfView: true,
        learnedDepth: true,
      });
      const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });
      const truthFrame = SERVE_PRESETS.elite.contactT * 240;
      if (report.contactFrame === null) continue;
      const errorS = Math.abs(report.contactFrame - truthFrame) / 240;
      if (errorS > 0.025) {
        assert.ok(
          report.contactConfidence < 0.6,
          `${rig}/${seed}: contact off by ${(errorS * 1000).toFixed(0)} ms but reported with ` +
            `${(report.contactConfidence * 100).toFixed(0)} % confidence`,
        );
      }
    }
  }
});

test("phase order is monotone and covers the clip", () => {
  const scenario = buildScenario("phases", "Phasen", {
    preset: "elite",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });
  assert.ok(report.phases.length >= 6, "a serve must be split into at least six phases");
  for (let i = 1; i < report.phases.length; i++) {
    assert.ok(
      report.phases[i].startFrame >= report.phases[i - 1].startFrame - 1e-6,
      "phases must be in order",
    );
  }
  const contactPhase = report.phases.find((p) => p.id === "contact");
  assert.ok(contactPhase, "a contact phase must exist");
});

/* ------------------------------------------------------------------ */
/* Feature accuracy and uncertainty calibration                        */
/* ------------------------------------------------------------------ */

test("measured features land inside their own stated uncertainty", () => {
  // The central claim of the whole design: the intervals mean something. Across
  // repeated captures of a known motion, the true value must fall inside the
  // reported 95 % interval most of the time. An interval that is right 20 % of
  // the time is a lie; one that is right 100 % of the time is uselessly wide.
  const params = SERVE_PRESETS.elite;
  const truth = generateServe(params, 480);
  const contactIndex = Math.round(params.contactT * 480);
  const expectations: Array<{ id: string; truth: number; tolerance: number }> = [
    { id: "kneeFlexionPeak", truth: params.kneeFlexPeakDeg, tolerance: 0 },
    { id: "elbowFlexionAtContact", truth: truth.frames[contactIndex].dof.elbowFlexDeg, tolerance: 0 },
    { id: "pelvisPeakLead", truth: params.pelvisPeakLeadS, tolerance: 0 },
    { id: "trunkPeakLead", truth: params.trunkPeakLeadS, tolerance: 0 },
    { id: "sequenceMargin", truth: params.trunkPeakLeadS - params.pelvisPeakLeadS, tolerance: 0 },
    { id: "contactHeightRatio", truth: truth.contactHeightFraction, tolerance: 0 },
  ];

  let inside = 0;
  let total = 0;
  const misses: string[] = [];
  for (const seed of [3, 11, 23, 47, 71]) {
    const scenario = buildScenario(`cal-${seed}`, "Kalibrierung", {
      preset: "elite",
      level: "elite",
      rig: "elevatedSide",
      fps: 240,
      seed,
      knownFieldOfView: true,
      learnedDepth: true,
    });
    const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });
    for (const e of expectations) {
      const m = metric(report, e.id);
      if (!m || m.value === null || m.interval95 === null || m.confidence < 0.35) continue;
      total++;
      const [lo, hi] = m.interval95;
      if (e.truth >= lo - e.tolerance && e.truth <= hi + e.tolerance) inside++;
      else misses.push(`${e.id}@${seed}: true ${e.truth.toFixed(3)} outside [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
    }
  }

  assert.ok(total >= 15, `too few usable measurements to judge calibration (${total})`);
  const coverage = inside / total;
  assert.ok(
    coverage >= 0.7,
    `only ${(coverage * 100).toFixed(0)} % of true values fell inside the reported 95 % intervals. ` +
      `Misses: ${misses.slice(0, 6).join("; ")}`,
  );
});

test("a worse capture never produces a higher analysis quality", () => {
  const grades = [
    { id: "labor", render: GOOD_CAPTURE, fps: 240, rig: "elevatedSide" as const },
    { id: "phone", render: PHONE_CAPTURE, fps: 120, rig: "diagonal" as const },
    {
      id: "schlecht",
      render: { ...PHONE_CAPTURE, noisePx: 8, baseScore: 0.6, dropoutRate: 0.1 },
      fps: 30,
      rig: "side" as const,
    },
  ];
  const scores = grades.map((g) => {
    const scenario = buildScenario(`grade-${g.id}`, g.id, {
      preset: "elite",
      level: "elite",
      rig: g.rig,
      fps: g.fps,
      render: g.render,
      knownFieldOfView: g.id === "labor",
    });
    return { id: g.id, score: analyse(scenario.request, { now: NOW }).report.quality.overall };
  });
  for (let i = 1; i < scores.length; i++) {
    assert.ok(
      scores[i].score <= scores[i - 1].score,
      `quality did not decrease monotonically: ${scores.map((s) => `${s.id}=${s.score}`).join(", ")}`,
    );
  }
});

test("the report is deterministic for a given input", () => {
  const scenario = buildScenario("determinism", "Reproduzierbarkeit", {
    preset: "elite",
    fps: 240,
    knownFieldOfView: true,
  });
  const a = analyse(scenario.request, { now: NOW }).report;
  const b = analyse(scenario.request, { now: NOW }).report;
  assert.equal(JSON.stringify(a), JSON.stringify(b), "the same input must produce the same report");
});
