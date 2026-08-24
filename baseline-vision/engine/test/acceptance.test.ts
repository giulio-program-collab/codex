import test from "node:test";
import assert from "node:assert/strict";

import { analyse } from "../src/pipeline.ts";
import { buildScenario, PHONE_CAPTURE } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS } from "../src/fixtures/serve-model.ts";
import { metric } from "./helpers.ts";
import type { HistoricalSample } from "../src/layers/l11-reference.ts";

/**
 * The acceptance tests from the brief, in its order.
 *
 * These are the tests that decide whether the system is fit to put in front of
 * a coach. They are deliberately stated as properties of the *output* — what
 * the system may and may not say — rather than as numeric regressions on
 * intermediate values, because the requirement is about the product's
 * behaviour, not about any particular implementation of it.
 */

const NOW = "2026-08-24T00:00:00Z";

/* ------------------------------------------------------------------ */
/* Test 1 — a world-class serve is not called bad                      */
/* ------------------------------------------------------------------ */

test("T1: a world-class serve is never assessed as poor without a stated reason", () => {
  const scenario = buildScenario("t1", "Weltklasse-Aufschlag, gute Aufnahme", {
    preset: "elite",
    level: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });

  if (report.verdict.kind === "assessment") {
    assert.ok(
      (report.verdict.score as number) >= 70,
      `an elite serve scored ${report.verdict.score}; if that is genuinely what the measurements say, ` +
        "the expectation check must have suppressed the verdict instead of publishing it",
    );
  } else {
    // Refusing is always allowed. Refusing *silently* is not.
    assert.ok(report.verdict.reasons.length > 0, "a refusal must state its reasons");
  }

  // Whatever the verdict, no finding may claim a technical fault at high
  // confidence on a stroke this good.
  const confidentFaults = report.findings.filter((f) => f.confidence > 0.8 && f.source === "reference");
  assert.equal(
    confidentFaults.length,
    0,
    `high-confidence faults reported on an elite serve: ${confidentFaults.map((f) => f.id).join(", ")}`,
  );
});

test("T1b: an implausibly harsh verdict is caught by the expectation check", () => {
  // The same clip, but the pipeline is told the player is elite while the
  // motion is a developing junior's. The composite must not be published as if
  // it were a considered judgement of a professional.
  const scenario = buildScenario("t1b", "Erwartungswiderspruch", {
    preset: "developing",
    level: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });
  if (report.verdict.kind === "assessment" && (report.verdict.score as number) < 60) {
    assert.fail("a verdict far below the level's expected band was published without being questioned");
  }
  if (report.verdict.kind === "no_reliable_assessment") {
    assert.ok(report.verdict.reasons.length > 0);
  }
});

/* ------------------------------------------------------------------ */
/* Test 2 — bad video quality                                          */
/* ------------------------------------------------------------------ */

test("T2: poor video quality raises uncertainty and withholds the verdict", () => {
  const good = buildScenario("t2-good", "Gute Aufnahme", {
    preset: "elite",
    level: "elite",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const bad = buildScenario("t2-bad", "30 fps, verrauscht, dunkel", {
    preset: "elite",
    level: "elite",
    fps: 30,
    captureFps: 30,
    render: { ...PHONE_CAPTURE, noisePx: 9, blurNoiseFactor: 1.1, baseScore: 0.55, dropoutRate: 0.12 },
  });

  const goodReport = analyse(good.request, { now: NOW, depthPrior: good.depthPrior }).report;
  const badReport = analyse(bad.request, { now: NOW }).report;

  assert.ok(
    badReport.quality.overall < goodReport.quality.overall,
    "a worse clip must not score higher on analysis quality",
  );
  assert.equal(badReport.verdict.kind, "no_reliable_assessment");
  assert.ok(badReport.verdict.reasons.length > 0);

  // No measurement may come back from a 30 fps clip claiming high confidence.
  for (const m of badReport.metrics) {
    assert.ok(m.confidence <= 0.85, `${m.id} claims ${m.confidence} confidence on a 30 fps clip`);
  }
});

test("T2b: timing analysis is refused outright below the frame-rate floor", () => {
  const scenario = buildScenario("t2b", "30 fps", { preset: "elite", fps: 30, captureFps: 30 });
  const { report } = analyse(scenario.request, { now: NOW });
  const speed = report.notMeasurable.find((n) => n.id === "racketHeadPeakSpeed");
  assert.ok(speed, "racket-head speed must be declared unmeasurable at 30 fps");
  assert.ok((speed?.reason ?? "").length > 0);
});

/* ------------------------------------------------------------------ */
/* Test 3 — occlusion                                                  */
/* ------------------------------------------------------------------ */

test("T3: occluded body parts are reported as missing, not interpolated into findings", () => {
  const scenario = buildScenario("t3", "Verdeckte Beine", {
    preset: "elite",
    level: "elite",
    fps: 240,
    knownFieldOfView: true,
    render: {
      occlusionWindows: [
        { startS: 0.5, endS: 1.3, joints: ["kneeL", "kneeR", "ankleL", "ankleR", "footL", "footR"] },
      ],
    },
  });
  const { report } = analyse(scenario.request, { now: NOW });

  const knee = metric(report, "kneeFlexionPeak");
  const kneeMissing = report.notMeasurable.find((n) => n.id === "kneeFlexionPeak");
  assert.ok(
    kneeMissing || !knee || knee.confidence < 0.5,
    "knee flexion must not be reported confidently while the legs are occluded",
  );
  assert.ok(
    report.issues.some((i) => i.severity !== "info"),
    "a long occlusion must surface as an issue",
  );
});

/* ------------------------------------------------------------------ */
/* Test 4 — tracking failure                                           */
/* ------------------------------------------------------------------ */

test("T4: an injected tracking failure is detected and reported", () => {
  const scenario = buildScenario("t4", "Trackingfehler", {
    preset: "elite",
    level: "elite",
    fps: 240,
    knownFieldOfView: true,
    render: {
      limbSwapWindow: { startS: 0.7, endS: 1.0 },
      jumpInjection: { atS: 1.1, joint: "wristR", px: 320 },
    },
  });
  const { report } = analyse(scenario.request, { now: NOW });
  const tracking = report.pipeline.find((l) => l.id === "L5");
  assert.ok(tracking);
  assert.ok(
    (tracking?.notes ?? []).some((nte) => nte.includes("Vertauschung")) ||
      Number(tracking?.diagnostics.limbSwapUebergaenge ?? 0) > 0,
    "the limb swap must be recorded in the tracking layer's own diagnostics",
  );
  assert.ok(Number(tracking?.diagnostics.verworfeneStichproben ?? 0) > 0);
});

/* ------------------------------------------------------------------ */
/* Test 5 — amateur                                                    */
/* ------------------------------------------------------------------ */

test("T5: a developing player's real deficits are found, and only those", () => {
  const scenario = buildScenario("t5", "Nachwuchsspieler", {
    preset: "developing",
    level: "junior_development",
    ageYears: 13,
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });

  // The fixture is built with a shallow load (28 deg peak knee flexion against
  // an elite mean of 64.5) and a reversed proximal-distal sequence. At least
  // one of those has to be found; they are the two things a coach would see
  // first.
  const found = report.findings.map((f) => f.id);
  assert.ok(
    found.some((id) => id === "rule_shallow_load" || id === "rule_sequence_reversed" || id === "rule_no_leg_drive"),
    `no mechanical deficit found; findings were: ${found.join(", ") || "(none)"}`,
  );

  // And it must not manufacture faults out of every difference from a
  // professional: findings driven purely by a mismatched reference cohort are
  // not allowed to appear.
  for (const f of report.findings) {
    if (f.source !== "reference") continue;
    const m = report.metrics.find((x) => f.id === `ref_${x.id}`);
    assert.ok(
      !m || m.reference === null || m.reference.deviation !== "nicht_unterscheidbar",
      `${f.id} was reported although the comparison could not distinguish this player from the reference`,
    );
  }
});

test("T5b: the developing serve is measurably different from the elite one", () => {
  const build = (preset: "elite" | "developing", level: "elite" | "junior_development") =>
    analyse(
      buildScenario("cmp", "Vergleich", {
        preset,
        level,
        rig: "elevatedSide",
        fps: 240,
        knownFieldOfView: true,
        learnedDepth: true,
      }).request,
      {
        now: NOW,
        depthPrior: buildScenario("cmp", "Vergleich", {
          preset,
          level,
          rig: "elevatedSide",
          fps: 240,
          knownFieldOfView: true,
          learnedDepth: true,
        }).depthPrior,
      },
    ).report;

  const elite = build("elite", "elite");
  const junior = build("developing", "junior_development");

  const eliteKnee = metric(elite, "kneeFlexionPeak")?.value ?? 0;
  const juniorKnee = metric(junior, "kneeFlexionPeak")?.value ?? 0;
  assert.ok(
    eliteKnee > juniorKnee + 15,
    `knee flexion did not separate the two serves: elite ${eliteKnee}, junior ${juniorKnee}`,
  );

  const eliteSpeed = metric(elite, "racketHeadPeakSpeed")?.value ?? 0;
  const juniorSpeed = metric(junior, "racketHeadPeakSpeed")?.value ?? 0;
  assert.ok(eliteSpeed > juniorSpeed, "the elite serve must produce the faster racket head");
});

/* ------------------------------------------------------------------ */
/* Test 6 — the same player across sessions                            */
/* ------------------------------------------------------------------ */

test("T6: a real change between sessions is detected, and a non-change is not", () => {
  const base = SERVE_PRESETS.developing;
  const improved = { ...base, kneeFlexPeakDeg: 52 };

  const run = (params: typeof base, seed: number) => {
    const scenario = buildScenario("t6", "Session", {
      preset: params,
      level: "junior_development",
      ageYears: 13,
      rig: "elevatedSide",
      fps: 240,
      knownFieldOfView: true,
      learnedDepth: true,
      seed,
    });
    return analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior }).report;
  };

  // Five earlier sessions with the shallow load, then one with a real change.
  const history: HistoricalSample[] = [];
  for (let i = 0; i < 5; i++) {
    const r = run(base, 10 + i);
    const m = metric(r, "kneeFlexionPeak");
    if (m && m.value !== null) {
      history.push({
        sessionId: `s${i}`,
        date: `2026-0${i + 1}-01`,
        featureId: "kneeFlexionPeak",
        value: m.value,
        sd: m.sd ?? 5,
      });
    }
  }
  assert.ok(history.length >= 4, "the history fixture must produce comparable sessions");

  const changed = buildScenario("t6-changed", "Nach Veränderung", {
    preset: improved,
    level: "junior_development",
    ageYears: 13,
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
    seed: 99,
  });
  const changedReport = analyse(changed.request, {
    now: NOW,
    depthPrior: changed.depthPrior,
    history,
  }).report;
  const detected = changedReport.selfComparisons.find((s) => s.featureId === "kneeFlexionPeak");
  assert.ok(detected, "a self-comparison must be produced when history exists");
  assert.ok(
    detected!.meaningful,
    `a 24-degree change in knee flexion was not detected: delta ${detected!.delta.toFixed(1)}, ` +
      `history sd ${detected!.historySd.toFixed(1)}, p ${detected!.probabilityOfRealChange.toFixed(2)}`,
  );

  // A sixth session with no change must not be reported as one.
  const unchanged = buildScenario("t6-same", "Ohne Veränderung", {
    preset: base,
    level: "junior_development",
    ageYears: 13,
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
    seed: 98,
  });
  const unchangedReport = analyse(unchanged.request, {
    now: NOW,
    depthPrior: unchanged.depthPrior,
    history,
  }).report;
  const quiet = unchangedReport.selfComparisons.find((s) => s.featureId === "kneeFlexionPeak");
  assert.ok(quiet);
  assert.equal(quiet!.meaningful, false, "an unchanged session must not be reported as a change");
});

/* ------------------------------------------------------------------ */
/* Test 7 — camera perspectives                                        */
/* ------------------------------------------------------------------ */

test("T7: view-invariant metrics agree across camera angles, view-dependent ones are flagged", () => {
  const rigs = ["side", "diagonal", "elevatedSide", "behind"] as const;
  const reports = rigs.map((rig) => {
    const scenario = buildScenario(`t7-${rig}`, rig, {
      preset: "elite",
      level: "elite",
      rig,
      fps: 240,
      knownFieldOfView: true,
      learnedDepth: true,
    });
    return { rig, report: analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior }).report };
  });

  // Contact height as a fraction of stature is a scale-free, view-invariant
  // quantity: it must agree between cameras or be declared unmeasurable.
  const heights = reports
    .map(({ report }) => metric(report, "contactHeightRatio"))
    .filter((m) => m && m.value !== null && m.confidence >= 0.35)
    .map((m) => m!.value as number);
  assert.ok(heights.length >= 2, "at least two views must produce a usable contact height");
  const spread = Math.max(...heights) - Math.min(...heights);
  assert.ok(
    spread < 0.25,
    `contact height varied by ${spread.toFixed(2)} body heights across camera angles, ` +
      "which means the metric is not view-invariant as claimed",
  );

  // Every metric that survives must state its observability, and anything
  // dominated by depth must say so rather than passing as a clean measurement.
  for (const { rig, report } of reports) {
    for (const m of report.metrics) {
      assert.ok(
        ["direct", "reconstructed", "depth_limited", "unobservable"].includes(m.observability),
        `${rig}/${m.id} has no observability class`,
      );
      if (m.observability === "depth_limited") {
        assert.ok(
          m.notes.some((nte) => nte.includes("Tiefen")),
          `${rig}/${m.id} is depth-limited but does not say so`,
        );
      }
    }
  }
});

test("T7b: a camera that cannot see an axis reports that axis as unmeasurable", () => {
  // Side-on, the hip line points at the lens through the acceleration phase.
  const scenario = buildScenario("t7b", "Seitlich", {
    preset: "elite",
    level: "elite",
    rig: "side",
    fps: 240,
    knownFieldOfView: true,
  });
  const { report } = analyse(scenario.request, { now: NOW });
  const rotationIds = ["hipShoulderSeparationPeak", "pelvisPeakAngularVelocity", "pelvisPeakLead"];
  for (const id of rotationIds) {
    const m = metric(report, id);
    const missing = report.notMeasurable.find((nn) => nn.id === id);
    assert.ok(
      missing || !m || m.confidence < 0.9,
      `${id} was reported with high confidence from a camera that cannot resolve the axis`,
    );
  }
});
