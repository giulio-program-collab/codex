import test from "node:test";
import assert from "node:assert/strict";

import { ingest, timingAdmissibility } from "../src/layers/l01-ingest.ts";
import { calibrate } from "../src/layers/l02-calibration.ts";
import { detectPlayerTrack } from "../src/layers/l03-detection.ts";
import { NECK_ABOVE_STERNUM, adaptPoses, completeSkeleton } from "../src/layers/l04-pose.ts";
import { trackAndClean } from "../src/layers/l05-tracking.ts";
import { fitGlobalScale } from "../src/layers/l06-lift3d.ts";
import { MIN_RACKET_SPEED_HZ } from "../src/layers/l07-racket.ts";
import { trackBall } from "../src/layers/l08-ball.ts";
import { cohortMismatchSd, compareToReference, compareToSelf, SERVE_REFERENCES } from "../src/layers/l11-reference.ts";
import { assessQuality, MIN_QUALITY_FOR_VERDICT } from "../src/layers/l12-confidence.ts";
import { anthropometryFor, expectedBoneLengths } from "../src/fixtures/anthropometry.ts";
import { buildScenario } from "../src/fixtures/scenarios.ts";
import { BONES, type AnalysisRequest, type FrameObservation, type PlayerProfile } from "../src/core/types.ts";
import { dist2 } from "../src/core/math.ts";

const PLAYER: PlayerProfile = {
  id: "t",
  displayName: "Test",
  heightCm: 180,
  hand: "right",
  backhand: "two_handed",
  level: "high_performance",
};

function emptyRequest(overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
  const frames: FrameObservation[] = Array.from({ length: 60 }, (_, i) => ({
    index: i,
    t: i / 120,
    pose2d: {
      head: { p: { x: 900, y: 200 }, score: 0.9 },
      shoulderL: { p: { x: 880, y: 300 }, score: 0.9 },
      shoulderR: { p: { x: 940, y: 300 }, score: 0.9 },
      hipL: { p: { x: 890, y: 520 }, score: 0.9 },
      hipR: { p: { x: 930, y: 520 }, score: 0.9 },
      kneeL: { p: { x: 890, y: 700 }, score: 0.9 },
      kneeR: { p: { x: 930, y: 700 }, score: 0.9 },
      ankleL: { p: { x: 890, y: 870 }, score: 0.9 },
      ankleR: { p: { x: 930, y: 870 }, score: 0.9 },
    },
  }));
  return {
    video: { fps: 120, captureFps: 120, widthPx: 1920, heightPx: 1080, durationS: 0.5 },
    player: PLAYER,
    stroke: "serve",
    frames,
    ...overrides,
  };
}

/* ---------------- Layer 1 ---------------- */

test("L1 refuses timing analysis below the frame-rate floor", () => {
  const slow = timingAdmissibility(30, 10);
  assert.equal(slow.timingAllowed, false);
  assert.ok((slow.reason ?? "").includes("18 ms"));

  const fast = timingAdmissibility(240, 3);
  assert.equal(fast.timingAllowed, true);
});

test("L1 requires more repetitions at lower frame rates", () => {
  assert.equal(timingAdmissibility(60, 1).repetitionsRequired, 5);
  assert.equal(timingAdmissibility(120, 1).repetitionsRequired, 3);
});

test("L1 fails a clip that is too short to contain a stroke", () => {
  const r = ingest(emptyRequest({ frames: [] }));
  assert.equal(r.fatal, true);
  assert.equal(r.report.status, "failed");
});

test("L1 uses the capture rate, not the playback rate, for scene time", () => {
  const r = ingest(
    emptyRequest({
      video: { fps: 30, captureFps: 240, widthPx: 1920, heightPx: 1080, durationS: 2 },
    }),
  );
  assert.equal(r.effectiveHz, 240);
  assert.ok(Math.abs(r.dtScene - 1 / 240) < 1e-9);
});

test("L1 flags contradictory frame-rate metadata", () => {
  const r = ingest(
    emptyRequest({
      video: { fps: 120, captureFps: 30, widthPx: 1920, heightPx: 1080, durationS: 2 },
    }),
  );
  assert.ok(r.report.notes.some((n) => n.includes("widersprechen")));
});

/* ---------------- Layer 2 ---------------- */

test("L2 marks an assumed focal length with a large uncertainty", () => {
  const withoutExif = calibrate(emptyRequest());
  assert.equal(withoutExif.intrinsics.source, "assumed");
  assert.ok(withoutExif.subjectDepthRelSd > 0.15);

  const withExif = calibrate(
    emptyRequest({
      video: { fps: 120, captureFps: 120, widthPx: 1920, heightPx: 1080, durationS: 0.5, hfovDeg: 55 },
    }),
  );
  assert.equal(withExif.intrinsics.source, "exif");
  assert.ok(withExif.subjectDepthRelSd < withoutExif.subjectDepthRelSd);
});

test("L2 recovers the subject distance from a synthetic clip", () => {
  const scenario = buildScenario("cal", "Distanzschätzung", { knownFieldOfView: true, rig: "elevatedSide" });
  const cal = calibrate(scenario.request);
  assert.ok(cal.subjectDepthM !== null);
  // The elevated side rig stands about 9.4 m from the player.
  assert.ok(Math.abs((cal.subjectDepthM as number) - 9.4) < 1.5, `got ${cal.subjectDepthM}`);
});

/* ---------------- Layer 3 ---------------- */

test("L3 detects an identity switch", () => {
  const req = emptyRequest();
  // Teleport the whole skeleton half a body away, as a switch to another
  // player in the frame would.
  for (let i = 30; i < 60; i++) {
    for (const key of Object.keys(req.frames[i].pose2d)) {
      const kp = (req.frames[i].pose2d as Record<string, { p: { x: number; y: number } }>)[key];
      kp.p = { x: kp.p.x + 400, y: kp.p.y };
    }
  }
  const det = detectPlayerTrack(req.frames);
  assert.ok(det.identitySwitchFrames.length > 0);
  assert.notEqual(det.report.status, "ok");
});

/* ---------------- Layer 4 ---------------- */

test("L4 derives trunk landmarks consistently with the bone-length table", () => {
  const anthro = anthropometryFor(180, "right");
  const expected = expectedBoneLengths(anthro);
  // Build an upright skeleton at a known pixel scale and check that every
  // derived bone lands within tolerance of its table entry. A mismatch here
  // makes the reconstruction reject the joint in every frame.
  const pxPerM = 300;
  const trunkPx = (anthro.shoulderHeightM - anthro.hipHeightM) * pxPerM;
  const yHip = 800;
  const yShoulder = yHip - trunkPx;
  const yNeck = yShoulder - NECK_ABOVE_STERNUM * trunkPx;
  const yHead = yNeck - anthro.headAboveNeckM * 0.6 * pxPerM;
  const pose = completeSkeleton({
    head: { p: { x: 500, y: yHead }, score: 1 },
    shoulderL: { p: { x: 500 - (anthro.shoulderWidthM / 2) * pxPerM, y: yShoulder }, score: 1 },
    shoulderR: { p: { x: 500 + (anthro.shoulderWidthM / 2) * pxPerM, y: yShoulder }, score: 1 },
    hipL: { p: { x: 500 - (anthro.hipWidthM / 2) * pxPerM, y: yHip }, score: 1 },
    hipR: { p: { x: 500 + (anthro.hipWidthM / 2) * pxPerM, y: yHip }, score: 1 },
  });
  for (const [a, b] of BONES) {
    const ka = pose[a];
    const kb = pose[b];
    const L = expected[`${a}-${b}`];
    if (!ka || !kb || !L) continue;
    const measured = dist2(ka.p, kb.p) / pxPerM;
    assert.ok(
      measured <= L * 1.35,
      `derived bone ${a}-${b} is ${measured.toFixed(3)} m but the table allows at most ${(L * 1.35).toFixed(3)} m`,
    );
  }
});

test("L4 does not invent joints that cannot be derived", () => {
  const pose = completeSkeleton({ head: { p: { x: 0, y: 0 }, score: 1 } });
  assert.equal(pose.pelvis, undefined);
  assert.equal(pose.thorax, undefined);
});

/* ---------------- Layer 5 ---------------- */

test("L5 rejects an injected single-frame jump", () => {
  const scenario = buildScenario("jump", "Trackingfehler", {
    render: { jumpInjection: { atS: 0.9, joint: "wristR", px: 260 } },
  });
  const poses = adaptPoses(scenario.request.frames);
  const anthro = anthropometryFor(scenario.request.player.heightCm, "right");
  const cal = calibrate(scenario.request);
  const tracked = trackAndClean(poses.frames, {
    dtScene: 1 / scenario.request.video.captureFps,
    focalPx: cal.intrinsics.focalPx,
    subjectDepthM: cal.subjectDepthM,
    anthro,
  });
  const caught = tracked.outliers.filter(
    (o) => o.joint === "wristR" && (o.kind === "impossible_speed" || o.kind === "spike"),
  );
  assert.ok(caught.length > 0, "the injected jump must be rejected");
});

test("L5 detects and repairs a left/right limb swap", () => {
  const scenario = buildScenario("swap", "Seitenvertauschung", {
    render: { limbSwapWindow: { startS: 0.6, endS: 0.9 } },
  });
  const poses = adaptPoses(scenario.request.frames);
  const anthro = anthropometryFor(scenario.request.player.heightCm, "right");
  const cal = calibrate(scenario.request);
  const tracked = trackAndClean(poses.frames, {
    dtScene: 1 / scenario.request.video.captureFps,
    focalPx: cal.intrinsics.focalPx,
    subjectDepthM: cal.subjectDepthM,
    anthro,
  });
  assert.ok(
    tracked.outliers.some((o) => o.kind === "limb_swap"),
    "the swap must be detected",
  );
  assert.ok(tracked.report.notes.some((n) => n.includes("Vertauschung")));
});

test("L5 marks interpolated samples with reduced confidence", () => {
  const scenario = buildScenario("gap", "Kurze Lücke", {
    render: { occlusionWindows: [{ startS: 0.5, endS: 0.52, joints: ["kneeR"] }] },
  });
  const poses = adaptPoses(scenario.request.frames);
  const anthro = anthropometryFor(scenario.request.player.heightCm, "right");
  const cal = calibrate(scenario.request);
  const tracked = trackAndClean(poses.frames, {
    dtScene: 1 / scenario.request.video.captureFps,
    focalPx: cal.intrinsics.focalPx,
    subjectDepthM: cal.subjectDepthM,
    anthro,
  });
  for (const { frame, joint } of tracked.interpolated) {
    const kp = tracked.frames[frame]?.pose2d[joint];
    if (kp) assert.ok(kp.occluded === true, "interpolated samples must be marked");
  }
});

/* ---------------- Layer 6 ---------------- */

test("L6 scale fit recovers a deliberately wrong provisional distance", () => {
  const scenario = buildScenario("scale", "Skalenschätzung", { knownFieldOfView: true });
  const anthro = anthropometryFor(scenario.request.player.heightCm, "right");
  const expected = expectedBoneLengths(anthro);
  const cal = calibrate(scenario.request);
  const truthDepth = cal.subjectDepthM as number;
  for (const factor of [0.8, 1.25]) {
    const provisional = scenario.request.frames.map(() => truthDepth * factor);
    const fit = fitGlobalScale(scenario.request.frames, expected, provisional, cal.intrinsics.focalPx);
    const corrected = truthDepth * factor * fit.correction;
    assert.ok(
      Math.abs(corrected / truthDepth - 1) < 0.12,
      `scale fit left ${(corrected / truthDepth - 1) * 100}% error for factor ${factor}`,
    );
  }
});

/* ---------------- Layer 7 ---------------- */

test("L7 declares racket-head speed unresolvable below the frame-rate floor", () => {
  assert.equal(MIN_RACKET_SPEED_HZ, 120);
});

/* ---------------- Layer 8 ---------------- */

test("L8 never estimates ball speed", () => {
  const scenario = buildScenario("ball", "Ball", {});
  const result = trackBall(scenario.request.frames, { focalPx: 1900, effectiveHz: 240 });
  assert.ok(!("speed" in result));
  assert.ok(result.coverage >= 0 && result.coverage <= 1);
});

/* ---------------- Layer 11 ---------------- */

test("L11 widens rather than shifts the band for a mismatched cohort", () => {
  const band = SERVE_REFERENCES.find((b) => b.featureId === "kneeFlexionPeak");
  assert.ok(band);
  const junior: PlayerProfile = { ...PLAYER, level: "junior_development", heightCm: 155, ageYears: 13 };
  const adult: PlayerProfile = { ...PLAYER, level: "elite", heightCm: 186, ageYears: 26 };
  const wide = cohortMismatchSd(band!, junior);
  const narrow = cohortMismatchSd(band!, adult);
  assert.ok(wide.sd > narrow.sd, "a mismatched cohort must widen the band");
  assert.ok(wide.reasons.length >= 2);
  // The mean is a property of the band and is never touched.
  assert.equal(band!.mean, 64.5);
});

test("L11 refuses to score a band whose measurement convention is unconfirmed", () => {
  const unverified = SERVE_REFERENCES.filter((b) => b.definitionMatch === "unverified");
  assert.ok(unverified.length > 0, "the fixture must contain at least one unverified band");
  const feature = {
    id: unverified[0].featureId,
    label: "x",
    phase: "p",
    rationale: "r",
    measure: {
      value: unverified[0].mean + 60,
      sd: 3,
      confidence: 0.9,
      unit: unverified[0].unit,
      observability: "reconstructed" as const,
      provenance: [],
      notes: [],
    },
  };
  const c = compareToReference(feature, unverified[0], PLAYER);
  assert.equal(c.informative, false, "an unverified convention must never be scored");
});

test("L11 self-comparison needs both significance and practical size", () => {
  const history = Array.from({ length: 5 }, (_, i) => ({
    sessionId: `s${i}`,
    date: `2026-0${i + 1}-01`,
    featureId: "contactHeightRatio" as const,
    value: 1.4 + i * 0.002,
    sd: 0.02,
  }));
  const tiny = compareToSelf(
    "contactHeightRatio",
    { value: 1.405, sd: 0.001, confidence: 0.9, unit: "×", observability: "reconstructed", provenance: [], notes: [] },
    history,
  );
  assert.ok(tiny !== null && tiny.meaningful === false, "a change inside the player's own scatter is not news");

  const real = compareToSelf(
    "contactHeightRatio",
    { value: 1.52, sd: 0.01, confidence: 0.9, unit: "×", observability: "reconstructed", provenance: [], notes: [] },
    history,
  );
  assert.ok(real !== null && real.meaningful === true);
});

/* ---------------- Layer 12 ---------------- */

test("L12 blocks a verdict when a critical layer failed", () => {
  const q = assessQuality({
    layers: [
      { id: "L1", name: "a", status: "ok", quality: 1, notes: [], diagnostics: {} },
      { id: "L4", name: "b", status: "ok", quality: 0.9, notes: [], diagnostics: {} },
      { id: "L6", name: "c", status: "failed", quality: 0, notes: [], diagnostics: {} },
      { id: "L9", name: "d", status: "ok", quality: 0.8, notes: [], diagnostics: {} },
    ],
    features: [],
  });
  assert.equal(q.verdictAllowed, false);
  assert.ok(q.blockers.some((b) => b.includes("fehlgeschlagen")));
});

test("L12 does not let a strong component hide a collapsed one", () => {
  const layers = (segQuality: number) => [
    { id: "L1", name: "a", status: "ok" as const, quality: 1, notes: [], diagnostics: {} },
    { id: "L2", name: "cal", status: "ok" as const, quality: 1, notes: [], diagnostics: {} },
    { id: "L4", name: "pose", status: "ok" as const, quality: 1, notes: [], diagnostics: {} },
    { id: "L5", name: "track", status: "ok" as const, quality: 1, notes: [], diagnostics: {} },
    { id: "L6", name: "3d", status: "ok" as const, quality: 1, notes: [], diagnostics: {} },
    { id: "L7", name: "racket", status: "ok" as const, quality: 1, notes: [], diagnostics: {} },
    { id: "L8", name: "ball", status: "ok" as const, quality: 1, notes: [], diagnostics: {} },
    { id: "L9", name: "seg", status: "ok" as const, quality: segQuality, notes: [], diagnostics: {} },
  ];
  const good = assessQuality({ layers: layers(1), features: [] });
  const broken = assessQuality({ layers: layers(0.05), features: [] });
  assert.ok(good.overall > 90);
  assert.ok(
    broken.overall < MIN_QUALITY_FOR_VERDICT,
    `a collapsed segmentation must drag the score below the gate, got ${broken.overall}`,
  );
});
