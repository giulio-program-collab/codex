import type { Vec2, Vec3 } from "./math.ts";

/* ------------------------------------------------------------------ */
/* Skeleton                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tennis-specific joint set.
 *
 * It is deliberately larger than the 17-point COCO set that generic detectors
 * emit. The extra points (neck, sternum, thorax, spine, pelvis, hands, toes)
 * are the ones that carry the tennis meaning: without a pelvis and a thorax
 * frame there is no hip-shoulder separation, and without a hand there is no
 * defensible racket-grip anchor.
 *
 * Joints that no monocular detector observes directly are marked as DERIVED in
 * `JOINT_SOURCE` and are constructed by the skeleton model from observed ones —
 * with their own, larger uncertainty. Pretending they were measured is exactly
 * the failure mode this system exists to avoid.
 */
export const JOINTS = [
  "head",
  "neck",
  "sternum",
  "thorax",
  "spine",
  "pelvis",
  "shoulderL",
  "shoulderR",
  "elbowL",
  "elbowR",
  "wristL",
  "wristR",
  "handL",
  "handR",
  "hipL",
  "hipR",
  "kneeL",
  "kneeR",
  "ankleL",
  "ankleR",
  "footL",
  "footR",
] as const;

export type Joint = (typeof JOINTS)[number];

export type JointSource = "observed" | "derived";

export const JOINT_SOURCE: Record<Joint, JointSource> = {
  head: "observed",
  neck: "derived",
  sternum: "derived",
  thorax: "derived",
  spine: "derived",
  pelvis: "derived",
  shoulderL: "observed",
  shoulderR: "observed",
  elbowL: "observed",
  elbowR: "observed",
  wristL: "observed",
  wristR: "observed",
  handL: "derived",
  handR: "derived",
  hipL: "observed",
  hipR: "observed",
  kneeL: "observed",
  kneeR: "observed",
  ankleL: "observed",
  ankleR: "observed",
  footL: "observed",
  footR: "observed",
};

/** Rigid segments, used for bone-length constraints and for the 3D overlay. */
export const BONES: ReadonlyArray<readonly [Joint, Joint]> = [
  ["head", "neck"],
  ["neck", "sternum"],
  ["sternum", "thorax"],
  ["thorax", "spine"],
  ["spine", "pelvis"],
  ["neck", "shoulderL"],
  ["neck", "shoulderR"],
  ["shoulderL", "elbowL"],
  ["shoulderR", "elbowR"],
  ["elbowL", "wristL"],
  ["elbowR", "wristR"],
  ["wristL", "handL"],
  ["wristR", "handR"],
  ["pelvis", "hipL"],
  ["pelvis", "hipR"],
  ["hipL", "kneeL"],
  ["hipR", "kneeR"],
  ["kneeL", "ankleL"],
  ["kneeR", "ankleR"],
  ["ankleL", "footL"],
  ["ankleR", "footR"],
];

export type Side = "L" | "R";
export type Handedness = "right" | "left";

/** Resolves "the hitting-arm shoulder" to a concrete joint for a given player. */
export function sided(base: "shoulder" | "elbow" | "wrist" | "hand" | "hip" | "knee" | "ankle" | "foot", side: Side): Joint {
  return `${base}${side}` as Joint;
}

export const dominantSide = (hand: Handedness): Side => (hand === "right" ? "R" : "L");
export const otherSide = (s: Side): Side => (s === "L" ? "R" : "L");

/* ------------------------------------------------------------------ */
/* Per-frame observations                                              */
/* ------------------------------------------------------------------ */

/** One 2D keypoint as emitted by a pose estimator. */
export interface Keypoint2D {
  p: Vec2;
  /** Detector score in [0, 1]. */
  score: number;
  /** True when the estimator itself reports the joint as occluded/hallucinated. */
  occluded?: boolean;
}

export type Pose2D = Partial<Record<Joint, Keypoint2D>>;

/** One 3D joint estimate with an isotropic positional uncertainty, in metres. */
export interface Keypoint3D {
  p: Vec3;
  /** 1-sigma positional uncertainty in the image plane, metres. */
  sigmaInPlane: number;
  /** 1-sigma positional uncertainty along the camera axis, metres. */
  sigmaDepth: number;
  /** Overall confidence in [0, 1]; 0 means "this joint was not recovered". */
  confidence: number;
}

export type Pose3D = Partial<Record<Joint, Keypoint3D>>;

export interface FrameObservation {
  index: number;
  /** Presentation time in seconds from the start of the clip. */
  t: number;
  pose2d: Pose2D;
  racket?: RacketObservation;
  ball?: BallObservation;
}

export interface RacketObservation {
  /** Butt cap / grip end, image coordinates. */
  grip: Vec2;
  /** Centre of the racket head, image coordinates. */
  head: Vec2;
  score: number;
}

export interface BallObservation {
  p: Vec2;
  radiusPx: number;
  score: number;
}

/* ------------------------------------------------------------------ */
/* Measurements and uncertainty                                        */
/* ------------------------------------------------------------------ */

/**
 * How well a quantity can be observed from the given camera setup.
 *
 * This is the single most important type in the system. The old tool had no
 * equivalent: it computed a shoulder-elevation angle from three image points
 * and compared it against a mean derived from 8-camera Vicon data, as if the
 * two numbers measured the same thing. They do not.
 */
export type Observability =
  /** Scale- and view-invariant, or measured in a plane near-parallel to the image plane. */
  | "direct"
  /** Recovered from the monocular 3D lift; usable, but uncertainty comes from the lift. */
  | "reconstructed"
  /** Dominated by the depth component; only reportable when the view is favourable. */
  | "depth_limited"
  /** Cannot be obtained from this input at all. Reported as "not measurable", never estimated. */
  | "unobservable";

export interface Measure {
  /** Point estimate. `null` when the quantity could not be measured at all. */
  value: number | null;
  /** 1-sigma standard uncertainty of `value`, in `unit`. */
  sd: number | null;
  /**
   * Trust in [0, 1]. Distinct from `sd`: `sd` is the spread of a value we do
   * believe we measured; `confidence` is the probability that we measured the
   * right thing at all (correct joint, correct frame, correct player).
   */
  confidence: number;
  unit: string;
  observability: Observability;
  /** Which pipeline layers produced this value, for the debugging view. */
  provenance: string[];
  /** Human-readable caveats attached to this individual number. */
  notes: string[];
}

export const NOT_MEASURED = (
  unit: string,
  observability: Observability,
  provenance: string[],
  note: string,
): Measure => ({
  value: null,
  sd: null,
  confidence: 0,
  unit,
  observability,
  provenance,
  notes: [note],
});

/* ------------------------------------------------------------------ */
/* Pipeline plumbing                                                   */
/* ------------------------------------------------------------------ */

export type LayerStatus = "ok" | "degraded" | "failed" | "skipped";

export interface LayerReport {
  id: string;
  name: string;
  status: LayerStatus;
  /** Layer-local quality in [0, 1]; feeds the analysis quality score. */
  quality: number;
  notes: string[];
  /** Metrics that the layer itself measured, for the debug view. */
  diagnostics: Record<string, number | string | null>;
}

export interface VideoMeta {
  /** Frame rate of the file. */
  fps: number;
  /**
   * Rate the scene was captured at. For a slow-motion clip recorded at 240 fps
   * and stored at 30 fps this is 240 and `fps` is 30 — the distinction decides
   * whether timing analysis is admissible at all.
   */
  captureFps: number;
  widthPx: number;
  heightPx: number;
  durationS: number;
  /** Optional: horizontal field of view in degrees, if known from EXIF. */
  hfovDeg?: number;
}

export interface PlayerProfile {
  id: string;
  displayName: string;
  heightCm: number;
  hand: Handedness;
  /** Two-handed backhand changes the expected trunk kinematics materially. */
  backhand: "one_handed" | "two_handed";
  level: PlayerLevel;
  ageYears?: number;
  massKg?: number;
  /** Free-text style note; used only to widen reference bands, never to score. */
  styleNote?: string;
}

export type PlayerLevel = "junior_development" | "junior_national" | "college" | "high_performance" | "elite";

export type StrokeType = "serve" | "forehand" | "backhand";

export interface AnalysisRequest {
  video: VideoMeta;
  player: PlayerProfile;
  stroke: StrokeType;
  frames: FrameObservation[];
  /** Optional calibration hints supplied by the coach. */
  hints?: {
    /** Camera height above the court in metres, if measured. */
    cameraHeightM?: number;
    /** Coarse camera placement, if the coach knows it. */
    cameraPlacement?: CameraPlacement;
    /** Image-space court line correspondences, if the court is visible. */
    courtPoints?: Array<{ image: Vec2; world: Vec3 }>;
  };
  /** Deterministic seed; the same request always yields the same report. */
  seed?: number;
}

export type CameraPlacement =
  | "behind_baseline"
  | "side_on"
  | "diagonal"
  | "front_on"
  | "elevated_side"
  | "unknown";
