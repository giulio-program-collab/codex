import test from "node:test";
import assert from "node:assert/strict";

import { analyse } from "../src/pipeline.ts";
import {
  MIN_REPETITIONS_FOR_OUTLIER_REJECTION,
  MIN_REPETITION_QUALITY,
  analyseSession,
  type SessionRequest,
} from "../src/session.ts";
import { buildScenario, GOOD_CAPTURE, PHONE_CAPTURE } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS, type ServeParams } from "../src/fixtures/serve-model.ts";
import { methodBiasFor } from "../src/layers/l10-features.ts";
import { MIN_TIMING_HZ } from "../src/layers/l01-ingest.ts";
import { metric } from "./helpers.ts";

const NOW = "2026-08-24T00:00:00Z";

/** A set of repetitions of one player, with genuine stroke-to-stroke variation. */
function repetitions(options: {
  preset: keyof typeof SERVE_PRESETS;
  level: "elite" | "junior_development";
  count: number;
  fps?: number;
  jitter?: number;
  render?: Parameters<typeof buildScenario>[2]["render"];
  learnedDepth?: boolean;
}) {
  const base = SERVE_PRESETS[options.preset];
  const jitter = options.jitter ?? 1;
  return Array.from({ length: options.count }, (_, i) => {
    // Deterministic, spread across the set, so a repetition set is reproducible.
    const offset = ((i * 2654435761) % 1000) / 1000 - 0.5;
    const preset: ServeParams = {
      ...base,
      kneeFlexPeakDeg: base.kneeFlexPeakDeg + offset * 6 * jitter,
      separationPeakDeg: base.separationPeakDeg + offset * 4 * jitter,
      pelvisPeakLeadS: base.pelvisPeakLeadS + offset * 0.02 * jitter,
    };
    return buildScenario(`rep-${i}`, `Wiederholung ${i + 1}`, {
      preset,
      level: options.level,
      rig: "elevatedSide",
      fps: options.fps ?? 240,
      ageYears: options.level === "elite" ? 24 : 13,
      knownFieldOfView: true,
      learnedDepth: options.learnedDepth ?? true,
      render: options.render ?? GOOD_CAPTURE,
      seed: 20 + i * 13,
      playerId: options.level === "elite" ? "profi" : "nachwuchs",
    });
  });
}

function session(scenarios: ReturnType<typeof repetitions>, date = "2026-08-24"): SessionRequest {
  return {
    player: scenarios[0].request.player,
    stroke: "serve",
    repetitions: scenarios.map((s) => ({ request: s.request, depthPrior: s.depthPrior })),
    date,
  };
}

/* ------------------------------------------------------------------ */
/* The gate the system imposes on itself                               */
/* ------------------------------------------------------------------ */

test("a single stroke measures timing but may not have it scored against a reference", () => {
  const scenario = buildScenario("single", "Ein Schlag", {
    preset: "elite",
    level: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });

  const lead = metric(report, "pelvisPeakLead");
  assert.ok(lead && lead.value !== null, "the value is a real measurement of this stroke and stays");
  assert.equal(lead!.reference, null, "one repetition must not be scored against a population");
  assert.ok(
    lead!.notes.some((n) => /Wiederholung/.test(n)),
    "the reason must be stated on the measurement itself",
  );
});

test("below the frame-rate floor no timing value is produced at all", () => {
  const scenario = buildScenario("slow", "30 fps", {
    preset: "elite",
    level: "elite",
    rig: "elevatedSide",
    fps: 30,
    knownFieldOfView: true,
    learnedDepth: true,
  });
  const { report } = analyse(scenario.request, { now: NOW, depthPrior: scenario.depthPrior });

  for (const id of ["pelvisPeakLead", "trunkPeakLead", "sequenceMargin"]) {
    assert.ok(!metric(report, id), `${id} must not appear as a measurement at 30 fps`);
    const withheld = report.notMeasurable.find((n) => n.id === id);
    assert.ok(withheld, `${id} must be listed as not measurable`);
    assert.ok(
      withheld!.reason.includes(String(MIN_TIMING_HZ)) || /Auflösung/.test(withheld!.reason),
      "the reason must name the resolution problem",
    );
  }
});

test("enough repetitions unlock the reference comparison the single stroke was denied", () => {
  const many = analyseSession(session(repetitions({ preset: "elite", level: "elite", count: 6 })), {
    now: NOW,
  });
  assert.ok(many.timing.timingAllowed, "six repetitions at 240 Hz must clear the timing gate");

  const compared = many.comparisons.map((c) => c.featureId);
  assert.ok(
    compared.includes("pelvisPeakLead"),
    "the aggregated timing mean must reach the reference comparison",
  );

  const few = analyseSession(session(repetitions({ preset: "elite", level: "elite", count: 2 })), {
    now: NOW,
  });
  assert.equal(few.timing.timingAllowed, false, "two repetitions at 240 Hz must not clear the gate");
  assert.ok(
    !few.comparisons.some((c) => c.featureId === "pelvisPeakLead"),
    "below the repetition requirement no timing comparison may be produced",
  );
});

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

test("the aggregate reports the athlete's spread and the mean's precision separately", () => {
  const report = analyseSession(session(repetitions({ preset: "elite", level: "elite", count: 6 })), {
    now: NOW,
  });
  const knee = report.aggregates.find((a) => a.featureId === "kneeFlexionPeak");
  assert.ok(knee, "knee flexion must be aggregated");
  assert.ok(knee!.n >= 5, `expected at least five contributing repetitions, got ${knee!.n}`);
  assert.ok(knee!.sd !== null && knee!.sd > 0, "between-repetition spread must be reported");
  assert.equal(knee!.values.length, knee!.n);
  assert.ok(Math.abs(knee!.median - knee!.mean) < 5, "mean and median should agree on a clean set");
});

test("averaging cannot beat the method's own bias", () => {
  // The central statistical claim of session aggregation. sd/sqrt(n) alone
  // would promise that enough repetitions measure anything to arbitrary
  // precision; a systematic error does not average away.
  const small = analyseSession(session(repetitions({ preset: "elite", level: "elite", count: 4 })), {
    now: NOW,
  });
  const large = analyseSession(session(repetitions({ preset: "elite", level: "elite", count: 12 })), {
    now: NOW,
  });

  for (const id of ["kneeFlexionPeak", "pelvisPeakLead"] as const) {
    const floor = methodBiasFor(id);
    const a = small.aggregates.find((x) => x.featureId === id);
    const b = large.aggregates.find((x) => x.featureId === id);
    assert.ok(a && b, `${id} must be aggregated in both sessions`);
    assert.ok(a!.sem >= floor - 1e-9, `${id}: four repetitions claim ${a!.sem} below the floor ${floor}`);
    assert.ok(b!.sem >= floor - 1e-9, `${id}: twelve repetitions claim ${b!.sem} below the floor ${floor}`);
    assert.ok(b!.sem <= a!.sem + 1e-9, `${id}: more repetitions must not make the mean less certain`);
  }
});

test("a repetition too poor to analyse does not contaminate the mean", () => {
  const good = repetitions({ preset: "elite", level: "elite", count: 4 });
  const ruined = buildScenario("ruined", "Unbrauchbar", {
    preset: "elite",
    level: "elite",
    rig: "side",
    fps: 30,
    render: { ...PHONE_CAPTURE, noisePx: 12, baseScore: 0.45, dropoutRate: 0.25 },
  });
  const report = analyseSession(session([...good, ruined]), { now: NOW });

  assert.equal(report.repetitions.length, 5, "every repetition is still reported individually");
  assert.ok(report.excluded.length >= 1, "the unusable repetition must be excluded from the aggregate");
  assert.ok(
    report.excluded[0].reason.includes(String(MIN_REPETITION_QUALITY)),
    "the exclusion must name the threshold it failed",
  );
  for (const a of report.aggregates) {
    assert.ok(a.n <= 4, `${a.featureId} aggregated ${a.n} repetitions but only four were usable`);
  }
});

test("an outlier repetition is excluded and named, never silently dropped", () => {
  const normal = repetitions({ preset: "elite", level: "elite", count: 6 });
  // One repetition with a markedly shallower load than the rest.
  const odd = buildScenario("odd", "Ausreißer", {
    preset: { ...SERVE_PRESETS.elite, kneeFlexPeakDeg: 20 },
    level: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    learnedDepth: true,
    seed: 999,
  });
  const report = analyseSession(session([...normal, odd]), { now: NOW });

  const knee = report.aggregates.find((a) => a.featureId === "kneeFlexionPeak");
  assert.ok(knee, "knee flexion must be aggregated");
  assert.ok(
    knee!.values.length >= MIN_REPETITIONS_FOR_OUTLIER_REJECTION,
    "outlier rejection needs enough repetitions to be applied at all",
  );
  assert.ok(knee!.outliers.length >= 1, "the shallow repetition should be flagged as an outlier");
  assert.ok(
    knee!.outliers[0].deviations > 3,
    "an outlier must be reported with how far out it was, not just that it was",
  );
  // And it must not still be in the mean.
  assert.ok(
    !knee!.values.includes(knee!.outliers[0].value),
    "a rejected outlier must be out of the values that formed the mean",
  );
});

test("three repetitions are too few to reject an outlier, and none is rejected", () => {
  // With three values the robust scale estimate is itself noise; discarding one
  // of them is more likely to remove the truth than an error.
  const report = analyseSession(session(repetitions({ preset: "elite", level: "elite", count: 3, jitter: 3 })), {
    now: NOW,
  });
  for (const a of report.aggregates) {
    assert.equal(a.outliers.length, 0, `${a.featureId} rejected an outlier from only three repetitions`);
  }
});

test("a coefficient of variation is only offered where it means something", () => {
  const report = analyseSession(session(repetitions({ preset: "elite", level: "elite", count: 6 })), {
    now: NOW,
  });
  for (const a of report.aggregates) {
    if (a.cvPercent === null) continue;
    assert.ok(a.unit !== "s", `${a.featureId}: a lead time has no true zero, so no CV`);
    assert.ok(a.mean > 0, `${a.featureId}: CV needs a positive mean`);
    assert.ok(
      a.sd !== null && a.mean > 2 * a.sd,
      `${a.featureId}: CV was offered on a mean sitting inside its own scatter`,
    );
  }
});

test("the session is deterministic", () => {
  const request = session(repetitions({ preset: "elite", level: "elite", count: 4 }));
  const a = analyseSession(request, { now: NOW });
  const b = analyseSession(request, { now: NOW });
  assert.equal(JSON.stringify(a.aggregates), JSON.stringify(b.aggregates));
});
