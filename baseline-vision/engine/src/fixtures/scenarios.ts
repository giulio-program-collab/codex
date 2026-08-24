import { CAMERA_RIGS, renderClip, type RenderOptions } from "./render.ts";
import { SERVE_PRESETS, generateServe, type ServeParams, type ServeTruth } from "./serve-model.ts";
import { simulatedLearnedDepthPrior } from "./simulated-lift.ts";
import { cameraFromRig } from "./render.ts";
import type { AnalysisRequest, PlayerLevel, PlayerProfile } from "../core/types.ts";
import type { DepthPrior } from "../layers/l06-lift3d.ts";

/**
 * Named capture scenarios shared by the validation suite and the demo build.
 *
 * Keeping them in one place is what makes the acceptance tests comparable: when
 * a threshold moves, it moves against the same clips, and a regression is a
 * regression rather than a difference in how the fixture happened to be set up
 * that day.
 */

export interface Scenario {
  id: string;
  description: string;
  request: AnalysisRequest;
  truth: ServeTruth;
  depthPrior?: DepthPrior;
}

export interface ScenarioOptions {
  preset?: keyof typeof SERVE_PRESETS | ServeParams;
  level?: PlayerLevel;
  rig?: keyof typeof CAMERA_RIGS;
  fps?: number;
  captureFps?: number;
  /** Simulate a learned lift supplying depth; see `simulated-lift.ts`. */
  learnedDepth?: boolean | number;
  /** Tell the pipeline the field of view, as a calibrated setup would. */
  knownFieldOfView?: boolean;
  render?: Partial<RenderOptions>;
  seed?: number;
  ageYears?: number;
  playerId?: string;
}

/** Capture quality good enough for a reference comparison to mean something. */
export const GOOD_CAPTURE: Partial<RenderOptions> = {
  noisePx: 1.2,
  blurNoiseFactor: 0.12,
  baseScore: 0.97,
  dropoutRate: 0.002,
};

/** A phone held by a parent on the fence: the realistic worst acceptable case. */
export const PHONE_CAPTURE: Partial<RenderOptions> = {
  noisePx: 3.0,
  blurNoiseFactor: 0.4,
  baseScore: 0.9,
  dropoutRate: 0.015,
};

export function buildScenario(id: string, description: string, options: ScenarioOptions = {}): Scenario {
  const params: ServeParams =
    typeof options.preset === "object" ? options.preset : SERVE_PRESETS[options.preset ?? "elite"];
  const rigName = options.rig ?? "elevatedSide";
  const rig = CAMERA_RIGS[rigName];
  const fps = options.fps ?? 240;
  const truth = generateServe(params, 240);
  const clip = renderClip(truth, {
    rig,
    fps,
    captureFps: options.captureFps ?? fps,
    seed: options.seed ?? 5,
    ...GOOD_CAPTURE,
    ...options.render,
  });

  const level: PlayerLevel = options.level ?? "elite";
  const player: PlayerProfile = {
    id: options.playerId ?? "fixture-player",
    displayName: "Fixture",
    heightCm: params.heightCm,
    hand: params.hand,
    backhand: "two_handed",
    level,
    ageYears: options.ageYears ?? (level === "junior_development" ? 13 : 24),
  };

  const request: AnalysisRequest = {
    video: options.knownFieldOfView ? { ...clip.video, hfovDeg: rig.hfovDeg } : { ...clip.video, hfovDeg: undefined },
    player,
    stroke: "serve",
    frames: clip.frames,
    seed: 42,
  };

  const sigma = typeof options.learnedDepth === "number" ? options.learnedDepth : undefined;
  const depthPrior = options.learnedDepth
    ? simulatedLearnedDepthPrior(truth, cameraFromRig(rig), clip.frames.map((f) => f.t), sigma)
    : undefined;

  return { id, description, request, truth, depthPrior };
}
