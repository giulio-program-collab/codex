import type { Handedness } from "../core/types.ts";

/**
 * Segment lengths as fractions of standing height, after Winter,
 * *Biomechanics and Motor Control of Human Movement*, 4th ed., Table 4.1.
 *
 * These ratios do a job the old tool skipped entirely: they turn "the player is
 * 165 cm tall" into a full set of expected bone lengths, which the 3D lift then
 * uses as hard constraints. A reconstruction whose forearm changes length by
 * 30 % between two frames is not a reconstruction, it is noise, and bone-length
 * constraints are the cheapest way to reject it.
 */
export const SEGMENT_FRACTION = {
  headAboveNeck: 0.13,
  neckHeight: 0.87,
  shoulderHeight: 0.818,
  biacromialWidth: 0.245,
  hipHeight: 0.53,
  biiliacWidth: 0.191,
  upperArm: 0.186,
  forearm: 0.146,
  handToKnuckle: 0.108,
  thigh: 0.245,
  shank: 0.246,
  ankleHeight: 0.039,
  footLength: 0.152,
} as const;

/**
 * Where the three derived spine landmarks sit along the hip-to-shoulder line.
 *
 * These constants are shared by the pose adapter (which constructs the
 * landmarks), the bone-length table (which validates them) and the synthetic
 * fixtures (which generate them). Keeping them in one place is not tidiness:
 * a disagreement of a few centimetres between how a landmark is built and how
 * long its bone is supposed to be makes every frame fail the anatomical
 * plausibility check, and because the skeleton is a tree, that silently removes
 * everything distal to it.
 */
export const TRUNK_LANDMARK_FRACTION = {
  spine: 1 / 3,
  thorax: 2 / 3,
  sternum: 1,
} as const;

export interface Anthropometry {
  heightM: number;
  hand: Handedness;
  shoulderHeightM: number;
  neckHeightM: number;
  headAboveNeckM: number;
  hipHeightM: number;
  shoulderWidthM: number;
  hipWidthM: number;
  upperArmM: number;
  forearmM: number;
  handM: number;
  thighM: number;
  shankM: number;
  ankleHeightM: number;
  footLengthM: number;
  /** Racket length; ITF caps adult rackets at 73.7 cm, juniors use 63-66 cm. */
  racketLengthM: number;
}

export function anthropometryFor(heightCm: number, hand: Handedness, racketLengthM?: number): Anthropometry {
  const h = heightCm / 100;
  const f = SEGMENT_FRACTION;
  return {
    heightM: h,
    hand,
    shoulderHeightM: h * f.shoulderHeight,
    neckHeightM: h * f.neckHeight,
    headAboveNeckM: h * f.headAboveNeck,
    hipHeightM: h * f.hipHeight,
    shoulderWidthM: h * f.biacromialWidth,
    hipWidthM: h * f.biiliacWidth,
    upperArmM: h * f.upperArm,
    forearmM: h * f.forearm,
    handM: h * f.handToKnuckle * 0.5,
    thighM: h * f.thigh,
    shankM: h * f.shank,
    ankleHeightM: h * f.ankleHeight,
    footLengthM: h * f.footLength,
    racketLengthM: racketLengthM ?? (h >= 1.7 ? 0.685 : 0.66),
  };
}

/**
 * Redundant connections used only when the primary parent of a joint is
 * missing in a frame. The tennis skeleton is a tree, so losing a single
 * intermediate joint — the neck, say — disconnects both arms from the root and
 * costs every upper-body measurement. These edges give the reconstruction an
 * alternative route.
 */
export function fallbackBoneLengths(a: Anthropometry): Record<string, number> {
  return {
    "pelvis-sternum": a.shoulderHeightM - a.hipHeightM,
    "sternum-shoulderL": a.shoulderWidthM / 2,
    "sternum-shoulderR": a.shoulderWidthM / 2,
    "shoulderL-shoulderR": a.shoulderWidthM,
    "hipL-hipR": a.hipWidthM,
    "pelvis-thorax": (a.shoulderHeightM - a.hipHeightM) * 0.55,
  };
}

/**
 * Expected bone lengths in metres, keyed the same way as `BONES`.
 * Used by the 3D lift as a prior and by the outlier detector as a hard check.
 */
export function expectedBoneLengths(a: Anthropometry): Record<string, number> {
  return {
    "head-neck": a.headAboveNeckM * 0.6,
    // The sternum landmark is the acromion midpoint and the neck landmark is
    // cervicale, so this bone is exactly the height difference between them.
    // Any mismatch between how a derived joint is *constructed* and how long
    // this table says its bone is will be rejected as an impossible bone in
    // every single frame — and, because the skeleton is a tree, will silently
    // disconnect everything distal to it.
    "neck-sternum": a.neckHeightM - a.shoulderHeightM,
    // The three trunk bones divide the hip-to-shoulder line into thirds.
    "sternum-thorax": (a.shoulderHeightM - a.hipHeightM) / 3,
    "thorax-spine": (a.shoulderHeightM - a.hipHeightM) / 3,
    "spine-pelvis": (a.shoulderHeightM - a.hipHeightM) / 3,
    // Cervicale to acromion is not the half shoulder width: the two landmarks
    // differ in height as well. Getting this wrong by a few centimetres biases
    // the global scale estimate, because the scale is calibrated on whichever
    // segments appear longest relative to their table entry.
    "neck-shoulderL": Math.hypot(a.shoulderWidthM / 2, a.neckHeightM - a.shoulderHeightM),
    "neck-shoulderR": Math.hypot(a.shoulderWidthM / 2, a.neckHeightM - a.shoulderHeightM),
    "shoulderL-elbowL": a.upperArmM,
    "shoulderR-elbowR": a.upperArmM,
    "elbowL-wristL": a.forearmM,
    "elbowR-wristR": a.forearmM,
    "wristL-handL": a.handM,
    "wristR-handR": a.handM,
    "pelvis-hipL": a.hipWidthM / 2,
    "pelvis-hipR": a.hipWidthM / 2,
    "hipL-kneeL": a.thighM,
    "hipR-kneeR": a.thighM,
    "kneeL-ankleL": a.shankM,
    "kneeR-ankleR": a.shankM,
    "ankleL-footL": Math.hypot(a.footLengthM * 0.6, a.ankleHeightM * 0.6),
    "ankleR-footR": Math.hypot(a.footLengthM * 0.6, a.ankleHeightM * 0.6),
  };
}
