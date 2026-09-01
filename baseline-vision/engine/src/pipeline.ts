import type { PinholeCamera } from "./core/camera.ts";
import { anthropometryFor } from "./fixtures/anthropometry.ts";
import type { AnalysisRequest, LayerReport, Pose3D } from "./core/types.ts";
import { ingest } from "./layers/l01-ingest.ts";
import { calibrate } from "./layers/l02-calibration.ts";
import { detectPlayerTrack } from "./layers/l03-detection.ts";
import { adaptPoses } from "./layers/l04-pose.ts";
import { trackAndClean } from "./layers/l05-tracking.ts";
import { lift3D, type DepthPrior } from "./layers/l06-lift3d.ts";
import { trackRacket } from "./layers/l07-racket.ts";
import { trackBall } from "./layers/l08-ball.ts";
import { segment, type Phase } from "./layers/l09-segmentation.ts";
import { extractFeatures, type Feature } from "./layers/l10-features.ts";
import {
  compareToReference,
  compareToSelf,
  referencesFor,
  type Comparison,
  type HistoricalSample,
  type SelfComparison,
} from "./layers/l11-reference.ts";
import { assessQuality, meanFeatureConfidence } from "./layers/l12-confidence.ts";
import {
  buildFindings,
  composeScore,
  decideVerdict,
  runPlausibilityChecks,
} from "./layers/l13-interpretation.ts";
import { buildReport, type AnalysisReport } from "./layers/l14-report.ts";

/**
 * The pipeline, in the order the brief prescribes:
 *
 *   Video -> Qualitätsprüfung -> Erkennung -> Tracking -> 3D -> Segmentierung
 *         -> Biomechanik -> Vergleich -> Unsicherheit -> Interpretation -> Coaching
 *
 * No shortcuts. In particular, no layer may look at the final verdict, and the
 * verdict may not look at anything except what the layers produced. Each layer
 * is a pure function of its inputs and is exported separately so it can be
 * tested — and replaced — on its own.
 */

export interface PipelineOptions {
  /** Previous analyses of the same player, for the self-comparison. */
  history?: HistoricalSample[];
  /**
   * Optional learned depth prior for layer 6. Production deployments pass a
   * model here; the geometric solve runs on its own when they do not.
   */
  depthPrior?: DepthPrior;
  /** Fixed timestamp, so reports are byte-identical in tests. */
  now?: string;
  /**
   * How many repetitions of this stroke the session contains.
   *
   * Defaults to one. `analyseSession` passes the real count, which is what
   * makes inter-segment timing admissible for a reference comparison — see
   * `timingAdmissibility` in layer 1.
   */
  repetitions?: number;
}

export interface PipelineResult {
  report: AnalysisReport;
  /** Intermediate products, for the dashboard's overlay and 3D view. */
  intermediates: {
    poses3d: Pose3D[];
    phases: Phase[];
    features: Feature[];
    comparisons: Comparison[];
    selfComparisons: SelfComparison[];
    contactFrame: number | null;
    racketHeads: Array<{ x: number; y: number; z: number } | null>;
    /** Camera expressed in the court frame, so a viewer can re-project the skeleton. */
    cameraInCourt: PinholeCamera;
    verticalConfidence: number;
    mirrorConfidence: number;
  };
}

export function analyse(request: AnalysisRequest, options: PipelineOptions = {}): PipelineResult {
  const layers: LayerReport[] = [];
  const seed = request.seed ?? 20260824;
  const anthro = anthropometryFor(request.player.heightCm, request.player.hand);

  // --- L1 ---------------------------------------------------------------
  const ing = ingest(request);
  layers.push(ing.report);

  // --- L2 ---------------------------------------------------------------
  const cal = calibrate(request);
  layers.push(cal.report);

  // --- L3 / L4 ----------------------------------------------------------
  const det = detectPlayerTrack(request.frames);
  layers.push(det.report);
  const pose = adaptPoses(request.frames);
  layers.push(pose.report);

  // --- L5 ---------------------------------------------------------------
  const tracked = trackAndClean(pose.frames, {
    dtScene: ing.dtScene,
    focalPx: cal.intrinsics.focalPx,
    subjectDepthM: cal.subjectDepthM,
    anthro,
    identitySwitchFrames: det.identitySwitchFrames,
  });
  layers.push(tracked.report);

  // A fatal ingest failure still runs the pipeline far enough to produce a
  // useful diagnosis, but nothing downstream is allowed to claim a measurement.
  // --- L6 ---------------------------------------------------------------
  const lift = lift3D(tracked.frames, {
    camera: cal.camera,
    anthro,
    subjectDepthM: cal.subjectDepthM,
    subjectDepthRelSd: cal.subjectDepthRelSd,
    dtScene: ing.dtScene,
    depthPrior: options.depthPrior,
  });
  layers.push(lift.report);

  // --- L7 / L8 ----------------------------------------------------------
  const racket = trackRacket(tracked.frames, {
    camera: lift.cameraInCourt,
    poses3d: lift.poses,
    hand: request.player.hand,
    racketLengthM: anthro.racketLengthM,
    dtScene: ing.dtScene,
    effectiveHz: ing.effectiveHz,
  });
  layers.push(racket.report);

  const ball = trackBall(tracked.frames, {
    focalPx: cal.intrinsics.focalPx,
    effectiveHz: ing.effectiveHz,
  });
  layers.push(ball.report);

  // --- L9 ---------------------------------------------------------------
  const seg = segment(lift.poses, {
    stroke: request.stroke,
    hand: request.player.hand,
    dtScene: ing.dtScene,
    times: tracked.frames.map((f) => f.t),
    racket: racket.frames,
    ballContactFrame: ball.contactFrameFromBall,
    ballContactConfidence: ball.contactConfidence,
    ballImage: ball.track.map((t) => t.p),
    racketImage: tracked.frames.map((f) => f.racket?.head ?? null),
    manualContactFrame: request.hints?.contactFrame ?? null,
  });
  layers.push(seg.report);

  // --- L10 --------------------------------------------------------------
  const features = extractFeatures(lift.poses, {
    stroke: request.stroke,
    hand: request.player.hand,
    heightM: anthro.heightM,
    dtScene: ing.dtScene,
    camera: lift.cameraInCourt,
    segmentation: seg,
    racket,
    mirrorConfidence: lift.mirrorConfidence,
    targetDirConfidence: lift.targetDirConfidence,
    verticalConfidence: lift.verticalConfidence,
    scaleRelSd: lift.scaleRelSd,
    effectiveHz: ing.effectiveHz,
    repetitions: options.repetitions ?? 1,
    coverage: tracked.coverage,
    // The weakest of the layers a measurement depends on, not their average:
    // a perfect pose estimate on top of a broken reconstruction is still a
    // broken measurement.
    upstreamQuality: Math.min(pose.report.quality, tracked.report.quality, lift.report.quality),
    seed,
  });
  layers.push(features.report);

  // --- L11 --------------------------------------------------------------
  const bands = referencesFor(request.stroke);
  const comparisons: Comparison[] = [];
  for (const band of bands) {
    const feature = features.byId[band.featureId];
    if (!feature) continue;
    // A feature the measurement rules bar from comparison is skipped here, not
    // compared and then discounted: a z-score that must not be read is still
    // read by somebody.
    if (feature.referenceEligible === false) continue;
    comparisons.push(compareToReference(feature, band, request.player));
  }
  const selfComparisons: SelfComparison[] = [];
  for (const feature of features.features) {
    const s = compareToSelf(feature.id, feature.measure, options.history ?? []);
    if (s) selfComparisons.push(s);
  }
  layers.push({
    id: "L11",
    name: "Referenzvergleich",
    status: comparisons.length > 0 ? "ok" : "degraded",
    quality: comparisons.length ? comparisons.reduce((s, c) => s + c.confidence, 0) / comparisons.length : 0,
    notes:
      comparisons.length === 0
        ? ["Für diese Schlagart liegen keine publizierten Referenzverteilungen vor."]
        : [],
    diagnostics: {
      referenzen: comparisons.length,
      eigenvergleiche: selfComparisons.length,
      nichtUnterscheidbar: comparisons.filter((c) => c.deviation === "nicht_unterscheidbar").length,
    },
  });

  // --- L12 --------------------------------------------------------------
  const quality = assessQuality({ layers, features: features.features });
  layers.push({
    id: "L12",
    name: "Confidence-Bestimmung",
    status: quality.verdictAllowed ? "ok" : "degraded",
    quality: quality.overall / 100,
    notes: quality.blockers,
    diagnostics: Object.fromEntries(quality.components.map((c) => [c.id, c.score])),
  });

  // --- L13 --------------------------------------------------------------
  const composed = composeScore(comparisons, features.features);
  const issues = runPlausibilityChecks({
    player: request.player,
    layers,
    features: features.features,
    comparisons,
    quality,
    compositeScore: composed.score,
  });
  const findings = buildFindings({
    features: features.features,
    comparisons,
    selfComparisons,
    quality,
  });
  const verdict = decideVerdict(
    composed.score,
    composed.components,
    quality,
    issues,
    meanFeatureConfidence(features.features),
    features.features,
  );
  layers.push({
    id: "L13",
    name: "Plausibilitätsprüfung & Interpretation",
    // A partial result is a working layer, not a degraded one: it measured what
    // was there and declined only the composite.
    status: verdict.kind === "no_reliable_assessment" ? "degraded" : "ok",
    quality:
      verdict.kind === "assessment"
        ? (verdict.confidence ?? 0)
        : verdict.measured.total > 0
          ? verdict.measured.usable / verdict.measured.total
          : 0,
    notes: issues.filter((i) => i.severity === "blocking").map((i) => i.statement),
    diagnostics: {
      befunde: findings.length,
      blockierendeBefunde: issues.filter((i) => i.severity === "blocking").length,
      warnungen: issues.filter((i) => i.severity === "warning").length,
      bewertung: verdict.kind === "assessment" ? (verdict.score as number) : verdict.kind,
    },
  });

  // --- L14 --------------------------------------------------------------
  const report = buildReport({
    player: request.player,
    stroke: request.stroke,
    video: request.video,
    layers,
    features: features.features,
    comparisons,
    selfComparisons,
    quality,
    findings,
    issues,
    verdict,
    phases: seg.phases,
    contactFrame: seg.contactFrame,
    contactConfidence: seg.contactConfidence,
    now: options.now,
  });
  layers.push({
    id: "L14",
    name: "Trainer-Report",
    status: "ok",
    quality: 1,
    notes: [],
    diagnostics: { kennzahlen: report.metrics.length, nichtMessbar: report.notMeasurable.length },
  });

  return {
    report,
    intermediates: {
      poses3d: lift.poses,
      phases: seg.phases,
      features: features.features,
      comparisons,
      selfComparisons,
      contactFrame: seg.contactFrame,
      racketHeads: racket.frames.map((f) => f.head),
      cameraInCourt: lift.cameraInCourt,
      verticalConfidence: lift.verticalConfidence,
      mirrorConfidence: lift.mirrorConfidence,
    },
  };
}

export { type AnalysisReport } from "./layers/l14-report.ts";
export { renderPipelineTrail, renderHeadline } from "./layers/l14-report.ts";
