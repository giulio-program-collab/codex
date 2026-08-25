import { analyse, type PipelineResult } from "../src/pipeline.ts";
import { analyseSession, type SessionReport } from "../src/session.ts";
import { buildScenario, GOOD_CAPTURE, PHONE_CAPTURE, type ScenarioOptions } from "../src/fixtures/scenarios.ts";
import { rootRelativeJointErrorM } from "../src/fixtures/accuracy.ts";
import { CAMERA_RIGS, type RenderOptions } from "../src/fixtures/render.ts";
import { SERVE_PRESETS, generateServe, type ServeParams } from "../src/fixtures/serve-model.ts";
import { legacyServeScore, LEGACY_REFERENCES, type LegacyAngleId } from "../src/legacy/legacy-2d.ts";
import { project } from "../src/core/camera.ts";
import { BONES, JOINTS, type Joint, type PlayerLevel } from "../src/core/types.ts";
import type { AnalysisRequest } from "../src/core/types.ts";

/**
 * Browser entry point for the playground.
 *
 * The playground is not a demo of the engine — it *is* the engine. Everything
 * below runs the same `analyse` the tests run; the only thing this file adds is
 * a way to choose the capture conditions and a JSON-shaped answer for the user
 * interface to draw. That constraint matters: a playground fed by pre-rendered
 * output would let the interface show claims the engine cannot make, and the
 * whole point of this system is that it says only what it can support.
 */

export type CaptureGrade = "labor" | "gut" | "handy" | "schlecht";

export interface PlaygroundInput {
  preset: keyof typeof SERVE_PRESETS;
  level: PlayerLevel;
  ageYears: number;
  rig: keyof typeof CAMERA_RIGS;
  fps: number;
  capture: CaptureGrade;
  knownFieldOfView: boolean;
  learnedDepth: boolean;
  /** Repetitions in the session; 1 means a single clip. */
  repetitions: number;
  occlusion: boolean;
  seed: number;
}

export const CAPTURE_GRADES: Record<CaptureGrade, { label: string; note: string; render: Partial<RenderOptions> }> = {
  labor: {
    label: "Labor",
    note: "Stativ, gutes Licht, scharfe Kanten — 1,2 px Keypoint-Rauschen",
    render: { noisePx: 1.2, blurNoiseFactor: 0.12, baseScore: 0.97, dropoutRate: 0.002 },
  },
  gut: {
    label: "Gut",
    note: "Stativ, Hallenlicht — 2,0 px Keypoint-Rauschen",
    render: { noisePx: 2.0, blurNoiseFactor: 0.25, baseScore: 0.94, dropoutRate: 0.008 },
  },
  handy: {
    label: "Handy am Zaun",
    note: "Aus der Hand, Bewegungsunschärfe — 3,0 px Rauschen",
    render: { noisePx: 3.0, blurNoiseFactor: 0.4, baseScore: 0.9, dropoutRate: 0.015 },
  },
  schlecht: {
    label: "Schlecht",
    note: "Verwackelt, Gegenlicht, Spieler klein im Bild — 9,0 px Rauschen",
    render: { noisePx: 9, blurNoiseFactor: 0.6, baseScore: 0.55, dropoutRate: 0.12 },
  },
};

export const RIG_LABELS: Record<string, string> = {
  elevatedSide: "Erhöht seitlich",
  side: "Seitlich (Zaunhöhe)",
  diagonal: "Diagonal",
  behind: "Von hinten",
  front: "Von vorn (Rückschlagseite)",
};

export const PRESET_LABELS: Record<string, string> = {
  elite: "Weltklasse (ATP-Niveau)",
  highPerformance: "Leistungsklasse",
  developing: "Nachwuchs / Entwicklungsstand",
};

const OCCLUDED_JOINTS: Joint[] = ["hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR"];

function scenarioOptions(input: PlaygroundInput, index: number): ScenarioOptions {
  const grade = CAPTURE_GRADES[input.capture];
  const base = SERVE_PRESETS[input.preset];
  // Stroke-to-stroke variation, deterministic in the seed: a session of six
  // identical serves would make the aggregation look better than it is.
  const jitter = input.repetitions > 1 ? (((index * 2654435761) % 1000) / 1000 - 0.5) : 0;
  const preset: ServeParams = {
    ...base,
    kneeFlexPeakDeg: base.kneeFlexPeakDeg + jitter * 7,
    separationPeakDeg: base.separationPeakDeg + jitter * 4,
    pelvisPeakLeadS: base.pelvisPeakLeadS + jitter * 0.018,
  };
  return {
    preset,
    level: input.level,
    rig: input.rig,
    fps: input.fps,
    ageYears: input.ageYears,
    knownFieldOfView: input.knownFieldOfView,
    learnedDepth: input.learnedDepth,
    playerId: "playground",
    seed: input.seed + index * 13,
    render: {
      ...grade.render,
      ...(input.occlusion
        ? { occlusionWindows: [{ startS: 0.5, endS: 0.95, joints: OCCLUDED_JOINTS }] }
        : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Overlay geometry                                                    */
/* ------------------------------------------------------------------ */

export interface OverlayFrame {
  /** Detected 2D joints, image pixels; null where the detector saw nothing. */
  d: Array<[number, number] | null>;
  /** Reprojected 3D reconstruction, image pixels. */
  r: Array<[number, number] | null>;
  /** 3D joint positions in metres, for the rotatable view. */
  p: Array<[number, number, number] | null>;
  racket: [number, number, number, number] | null;
  ball: [number, number] | null;
}

function buildOverlay(result: PipelineResult, request: AnalysisRequest): OverlayFrame[] {
  const cam = result.intermediates.cameraInCourt;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;

  return request.frames.map((frame, i) => {
    const pose3d = result.intermediates.poses3d[i] ?? {};
    const detected: Array<[number, number] | null> = [];
    const reprojected: Array<[number, number] | null> = [];
    const points: Array<[number, number, number] | null> = [];

    for (const joint of JOINTS) {
      const kp = frame.pose2d[joint];
      detected.push(kp ? [r1(kp.p.x), r1(kp.p.y)] : null);
      const kp3 = pose3d[joint];
      if (kp3) {
        const pr = project(cam, kp3.p);
        reprojected.push(Number.isFinite(pr.p.x) ? [r1(pr.p.x), r1(pr.p.y)] : null);
        points.push([r3(kp3.p.x), r3(kp3.p.y), r3(kp3.p.z)]);
      } else {
        reprojected.push(null);
        points.push(null);
      }
    }

    const head = result.intermediates.racketHeads[i];
    const grip = pose3d[request.player.hand === "right" ? "handR" : "handL"];
    let racket: [number, number, number, number] | null = null;
    if (head && grip) {
      const a = project(cam, grip.p);
      const b = project(cam, head);
      if (Number.isFinite(a.p.x) && Number.isFinite(b.p.x)) {
        racket = [r1(a.p.x), r1(a.p.y), r1(b.p.x), r1(b.p.y)];
      }
    }

    return { d: detected, r: reprojected, p: points, racket, ball: frame.ball ? [r1(frame.ball.p.x), r1(frame.ball.p.y)] : null };
  });
}

/* ------------------------------------------------------------------ */
/* Ground truth                                                        */
/* ------------------------------------------------------------------ */

export interface TruthRow {
  id: string;
  truth: number;
  unit: string;
}

/**
 * The true value of every feature the model actually determines.
 *
 * This is the part no real capture can have, and it is why the playground is
 * worth having: the engine states an interval, and here we can check whether
 * the interval contains the answer.
 */
function truthRows(params: ServeParams): TruthRow[] {
  const truth = generateServe(params, 480);
  const contactIndex = Math.round(params.contactT * 480);
  const contact = truth.frames[contactIndex];
  const knee = truth.frames.map((f) => f.dof.kneeFlexDeg);
  const trophy = truth.frames[knee.indexOf(Math.max(...knee))];
  return [
    { id: "kneeFlexionPeak", truth: params.kneeFlexPeakDeg, unit: "deg" },
    { id: "trunkTiltAtTrophy", truth: trophy.dof.trunkTiltDeg, unit: "deg" },
    { id: "hipShoulderSeparationPeak", truth: params.separationPeakDeg, unit: "deg" },
    { id: "shoulderElevationAtContact", truth: contact.dof.shoulderElevDeg, unit: "deg" },
    { id: "elbowFlexionAtContact", truth: contact.dof.elbowFlexDeg, unit: "deg" },
    { id: "contactHeightRatio", truth: truth.contactHeightFraction, unit: "" },
    { id: "contactHeightM", truth: truth.contactHeightM, unit: "m" },
    { id: "contactAheadOfFrontFoot", truth: truth.contactAheadOfFrontFootM, unit: "m" },
    { id: "pelvisPeakLead", truth: params.pelvisPeakLeadS, unit: "s" },
    { id: "trunkPeakLead", truth: params.trunkPeakLeadS, unit: "s" },
    { id: "sequenceMargin", truth: params.trunkPeakLeadS - params.pelvisPeakLeadS, unit: "s" },
    { id: "racketHeadPeakSpeed", truth: truth.peakRacketHeadSpeedMs, unit: "m/s" },
  ];
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface LegacyView {
  overall: number;
  rows: Array<{ id: LegacyAngleId; label: string; measured: number; truth: number; z: number; score: number; mean: number; sd: number }>;
  /** The same serve, judged from every camera the tool might have been given. */
  byRig: Array<{ rig: string; label: string; overall: number }>;
}

export interface PlaygroundResult {
  input: PlaygroundInput;
  report: PipelineResult["report"];
  overlay: OverlayFrame[];
  video: { widthPx: number; heightPx: number; fps: number };
  contactFrame: number | null;
  phases: PipelineResult["report"]["phases"];
  truth: TruthRow[];
  accuracy: {
    jointErrorMm: number;
    verticalConfidence: number;
    mirrorConfidence: number;
  };
  legacy: LegacyView;
  session: SessionSummary | null;
  elapsedMs: number;
}

export interface SessionSummary {
  repetitionCount: number;
  excluded: SessionReport["excluded"];
  timing: { allowed: boolean; required: number; reason: string | null };
  quality: SessionReport["quality"];
  notes: string[];
  aggregates: Array<{
    featureId: string;
    label: string;
    unit: string;
    n: number;
    mean: number;
    sd: number | null;
    sem: number;
    systematicFloor: number;
    cvPercent: number | null;
    confidence: number;
    values: number[];
    outliers: SessionReport["aggregates"][number]["outliers"];
  }>;
  comparisons: Array<{
    featureId: string;
    informative: boolean;
    deviation: string;
    z: number | null;
    combinedSd: number;
    bandMean: number;
    bandSd: number;
    cohortReasons: string[];
  }>;
  findings: SessionReport["findings"];
}

const NOW = "2026-08-25T10:00:00Z";

export type Progress = (label: string, fraction: number) => void;

export function run(input: PlaygroundInput, progress: Progress = () => {}): PlaygroundResult {
  const started = Date.now();
  const steps = 3 + (input.repetitions > 1 ? input.repetitions : 0);
  let done = 0;
  const step = (label: string) => progress(label, done++ / steps);

  step("Aufnahme rendern");
  const primaryOptions = scenarioOptions(input, 0);
  const params = primaryOptions.preset as ServeParams;
  const primary = buildScenario("playground", "Playground", primaryOptions);

  step("Wurf 1 durch die Pipeline");
  const result = analyse(primary.request, {
    now: NOW,
    depthPrior: primary.depthPrior,
    repetitions: input.repetitions,
  });

  let session: SessionSummary | null = null;
  if (input.repetitions > 1) {
    const scenarios = [primary];
    for (let i = 1; i < input.repetitions; i++) {
      scenarios.push(buildScenario(`playground-${i}`, `Wiederholung ${i + 1}`, scenarioOptions(input, i)));
    }
    const s = analyseSession(
      {
        player: primary.request.player,
        stroke: "serve",
        date: "2026-08-25",
        repetitions: scenarios.map((sc) => ({ request: sc.request, depthPrior: sc.depthPrior })),
      },
      {
        now: NOW,
        onRepetition: (index, count) => step(`Wiederholung ${index + 1} von ${count} auswerten`),
      },
    );
    session = summariseSession(s);
  }

  step("Altes Verfahren auf derselben Aufnahme");
  const legacy = legacyView(params, input.rig);
  progress("Fertig", 1);

  return {
    input,
    report: result.report,
    overlay: buildOverlay(result, primary.request),
    video: {
      widthPx: primary.request.video.widthPx,
      heightPx: primary.request.video.heightPx,
      fps: primary.request.video.fps,
    },
    contactFrame: result.intermediates.contactFrame,
    phases: result.report.phases,
    truth: truthRows(params),
    accuracy: {
      jointErrorMm: rootRelativeJointErrorM(result.intermediates.poses3d, primary.truth, input.fps) * 1000,
      verticalConfidence: result.intermediates.verticalConfidence,
      mirrorConfidence: result.intermediates.mirrorConfidence,
    },
    legacy,
    session,
    elapsedMs: Date.now() - started,
  };
}

function legacyView(params: ServeParams, rig: keyof typeof CAMERA_RIGS): LegacyView {
  const truth = generateServe(params, 240);
  const here = legacyServeScore(rig, params, truth);
  const rigs = Object.keys(CAMERA_RIGS);
  return {
    overall: here.overall,
    rows: (Object.keys(LEGACY_REFERENCES) as LegacyAngleId[]).map((id) => ({
      id,
      label: LEGACY_REFERENCES[id].label,
      measured: here.angles[id],
      truth: here.truthAngles[id],
      z: here.zs[id],
      score: here.scores[id],
      mean: LEGACY_REFERENCES[id].mean,
      sd: LEGACY_REFERENCES[id].sd,
    })),
    byRig: rigs.map((rig) => ({
      rig,
      label: RIG_LABELS[rig] ?? rig,
      overall: legacyServeScore(rig, params, truth).overall,
    })),
  };
}

function summariseSession(s: SessionReport): SessionSummary {
  return {
    repetitionCount: s.repetitions.length,
    excluded: s.excluded,
    timing: { allowed: s.timing.timingAllowed, required: s.timing.repetitionsRequired, reason: s.timing.reason },
    quality: s.quality,
    notes: s.notes,
    aggregates: s.aggregates.map((a) => ({
      featureId: a.featureId,
      label: a.label,
      unit: a.unit,
      n: a.n,
      mean: a.mean,
      sd: a.sd,
      sem: a.sem,
      systematicFloor: a.systematicFloor,
      cvPercent: a.cvPercent,
      confidence: a.confidence,
      values: a.values,
      outliers: a.outliers,
    })),
    comparisons: s.comparisons.map((c) => ({
      featureId: c.featureId,
      informative: c.informative,
      deviation: c.deviation,
      z: c.z,
      combinedSd: c.combinedSd,
      bandMean: c.band.mean,
      bandSd: c.band.sd,
      cohortReasons: c.cohortReasons,
    })),
    findings: s.findings,
  };
}

/** Static metadata the interface needs before the first run. */
export const META = {
  joints: JOINTS,
  bones: BONES.map(([a, b]) => [JOINTS.indexOf(a), JOINTS.indexOf(b)]),
  rigs: Object.keys(CAMERA_RIGS).map((id) => ({ id, label: RIG_LABELS[id] ?? id })),
  presets: Object.keys(SERVE_PRESETS).map((id) => ({ id, label: PRESET_LABELS[id] ?? id })),
  captures: (Object.keys(CAPTURE_GRADES) as CaptureGrade[]).map((id) => ({
    id,
    label: CAPTURE_GRADES[id].label,
    note: CAPTURE_GRADES[id].note,
  })),
};
