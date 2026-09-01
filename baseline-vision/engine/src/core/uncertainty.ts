import { Rng, clamp, mean, normalCdf, sd as sampleSd } from "./math.ts";
import { cameraOffset, type PinholeCamera } from "./camera.ts";
import type { Joint, Measure, Observability, Pose3D } from "./types.ts";

/**
 * Uncertainty propagation.
 *
 * The pipeline never propagates uncertainty analytically. Joint angles,
 * segment-timing lags and separation angles are strongly non-linear functions
 * of joint positions, and a first-order Gaussian approximation understates the
 * spread exactly where it matters most — near a foreshortened limb, where the
 * derivative of the projected angle with respect to depth explodes.
 *
 * Instead every derived quantity is computed on N perturbed replicas of the
 * reconstructed skeleton, drawn from the per-joint covariance that the 3D lift
 * reports. The spread of the results *is* the uncertainty. It costs a few
 * milliseconds per metric and it is honest at any level of non-linearity.
 */

/**
 * Monte-Carlo replicas per measurement.
 *
 * The standard error of an estimated standard deviation is roughly
 * sd / sqrt(2N), so 48 replicas pin the reported uncertainty to about 10 % of
 * itself. That is well inside the precision anyone can act on — the difference
 * between "plus or minus 8 degrees" and "plus or minus 9 degrees" changes no
 * decision — and it keeps a full analysis inside a second.
 */
export const MC_SAMPLES = 48;

export interface McResult {
  value: number | null;
  sd: number | null;
  /** Fraction of Monte-Carlo replicas in which the quantity was computable. */
  validFraction: number;
  /** Mean over replicas; differs from `value` for order statistics. */
  replicaMean?: number | null;
}

/**
 * Draws a replica of `pose` by perturbing each joint with its anisotropic
 * uncertainty, expressed in the camera frame: `sigmaInPlane` across the two
 * image axes and `sigmaDepth` along the optical axis.
 */
export function perturbPose(pose: Pose3D, cam: PinholeCamera, rng: Rng): Pose3D {
  const out: Pose3D = {};
  for (const key of Object.keys(pose) as Joint[]) {
    const kp = pose[key];
    if (!kp) continue;
    const off = cameraOffset(
      cam,
      rng.gauss(0, kp.sigmaInPlane),
      rng.gauss(0, kp.sigmaInPlane),
      rng.gauss(0, kp.sigmaDepth),
    );
    out[key] = {
      ...kp,
      p: { x: kp.p.x + off.x, y: kp.p.y + off.y, z: kp.p.z + off.z },
    };
  }
  return out;
}

/** Runs `compute` over Monte-Carlo replicas of a single pose. */
export function propagatePose(
  pose: Pose3D,
  cam: PinholeCamera,
  compute: (p: Pose3D) => number | null,
  rng: Rng,
  samples = MC_SAMPLES,
): McResult {
  return propagate(() => perturbPose(pose, cam, rng), compute, rng, samples);
}

/**
 * Fraction of a joint's positional error that is constant over the clip rather
 * than independent per frame.
 *
 * This is not a tuning knob, it is a statement about where the error comes
 * from. The depth-scale error, the focal-length error and the anthropometric
 * bone-length error are identical in every frame of a clip; only detector
 * jitter is independent. Treating the whole error as independent would make
 * every velocity and every timing lag look far noisier than it is, because
 * differentiating white noise amplifies it; treating it all as correlated would
 * make them look far cleaner. The split matters most for exactly the quantities
 * the kinetic-chain analysis lives on.
 */
export const ERROR_CORRELATED_FRACTION = 0.6;

/**
 * Draws a replica of a whole sequence, with each joint's error split into a
 * clip-constant component and a per-frame component.
 */
export function perturbSequence(
  poses: Pose3D[],
  cam: PinholeCamera,
  rng: Rng,
  /**
   * Joints the caller's metric actually reads. Everything else is passed
   * through untouched — not as an approximation but because perturbing a joint
   * no one looks at costs time and changes nothing.
   */
  joints?: readonly Joint[],
): Pose3D[] {
  const rho = ERROR_CORRELATED_FRACTION;
  const rootRho = Math.sqrt(rho);
  const leafRho = Math.sqrt(1 - rho);
  const active: Joint[] = joints ? [...joints] : [];
  if (!joints) {
    const seen = new Set<Joint>();
    for (const pose of poses) {
      for (const key of Object.keys(pose) as Joint[]) {
        if (!seen.has(key)) {
          seen.add(key);
          active.push(key);
        }
      }
    }
  }
  const bias = new Map<Joint, { u: number; v: number; w: number }>();
  for (const key of active) bias.set(key, { u: rng.normal(), v: rng.normal(), w: rng.normal() });

  return poses.map((pose) => {
    const out: Pose3D = { ...pose };
    for (const key of active) {
      const kp = pose[key];
      if (!kp) continue;
      const b = bias.get(key)!;
      const su = kp.sigmaInPlane;
      const sd_ = kp.sigmaDepth;
      const off = cameraOffset(
        cam,
        su * (rootRho * b.u + leafRho * rng.normal()),
        su * (rootRho * b.v + leafRho * rng.normal()),
        sd_ * (rootRho * b.w + leafRho * rng.normal()),
      );
      out[key] = { ...kp, p: { x: kp.p.x + off.x, y: kp.p.y + off.y, z: kp.p.z + off.z } };
    }
    return out;
  });
}

/** Runs `compute` over Monte-Carlo replicas of a whole pose sequence. */
export function propagateSequence(
  poses: Pose3D[],
  cam: PinholeCamera,
  compute: (p: Pose3D[]) => number | null,
  rng: Rng,
  samples = MC_SAMPLES,
  joints?: readonly Joint[],
): McResult {
  return propagate(() => perturbSequence(poses, cam, rng, joints), compute, rng, samples);
}

/** Replica in which only the in-plane component of the error is active. */
function inPlaneOnly(poses: Pose3D[], joints?: readonly Joint[]): Pose3D[] {
  return poses.map((pose) => {
    const out: Pose3D = { ...pose };
    for (const key of (joints ?? (Object.keys(pose) as Joint[]))) {
      const kp = pose[key];
      if (kp) out[key] = { ...kp, sigmaDepth: 0 };
    }
    return out;
  });
}

/**
 * Runs the propagation twice — once with the full error model and once with the
 * depth component switched off — and reads the observability class off the
 * ratio.
 *
 * This replaces a hand-maintained table of "which metric works from which
 * camera angle" with a measurement. A shoulder-rotation angle is depth-limited
 * from a side view and well observed from above, and the same code discovers
 * that for every metric, for every clip, without anyone having to remember it.
 */
export function propagateSequenceClassified(
  poses: Pose3D[],
  cam: PinholeCamera,
  compute: (p: Pose3D[]) => number | null,
  rng: Rng,
  samples = MC_SAMPLES,
  joints?: readonly Joint[],
): { mc: McResult; observability: Observability; depthRatio: number | null } {
  const spread = propagateSequence(poses, cam, compute, rng, samples, joints);
  // The point estimate is computed on the reconstruction itself, not averaged
  // over the replicas. Many of these features are order statistics — a peak
  // knee flexion, a maximum angular velocity — and the expected maximum of a
  // noisy series is strictly larger than the maximum of its expectation. Using
  // the replica mean as the value would inflate every peak in the report by an
  // amount that grows with the noise, which is precisely the wrong direction:
  // the worse the video, the more athletic the player would appear.
  const nominal = compute(poses);
  const full: McResult = {
    value: nominal !== null && Number.isFinite(nominal) ? nominal : spread.value,
    sd: spread.sd,
    validFraction: spread.validFraction,
    replicaMean: spread.value,
  };
  if (full.value === null || full.sd === null) {
    return { mc: full, observability: "unobservable", depthRatio: null };
  }
  const flat = inPlaneOnly(poses, joints);
  const inPlane = propagateSequence(flat, cam, compute, rng, Math.max(16, Math.floor(samples / 3)), joints);
  const ratio = inPlane.sd !== null && inPlane.sd > 1e-9 ? full.sd / inPlane.sd : null;
  let observability: Observability = "reconstructed";
  if (ratio !== null && ratio > 2.5) observability = "depth_limited";
  if (ratio !== null && ratio <= 1.25) observability = "direct";
  return { mc: full, observability, depthRatio: ratio };
}

export function propagate<T>(
  draw: () => T,
  compute: (x: T) => number | null,
  _rng: Rng,
  samples = MC_SAMPLES,
): McResult {
  const vals: number[] = [];
  for (let i = 0; i < samples; i++) {
    const r = compute(draw());
    if (r !== null && Number.isFinite(r)) vals.push(r);
  }
  const validFraction = vals.length / samples;
  if (vals.length < Math.max(8, samples * 0.5)) {
    return { value: null, sd: null, validFraction };
  }
  return { value: mean(vals), sd: sampleSd(vals), validFraction };
}

/* ------------------------------------------------------------------ */
/* Building measures                                                   */
/* ------------------------------------------------------------------ */

export interface MeasureSpec {
  unit: string;
  observability: Observability;
  provenance: string[];
  /**
   * Trust factors in [0, 1] that gate the measure independently of its spread —
   * joint detection scores, phase-detection certainty, the fraction of the
   * relevant window that was actually tracked. Combined by `combineTrust`, so a
   * single collapsed factor still suppresses a strong claim while a list of
   * merely good ones does not.
   */
  trust: Array<{ label: string; value: number }>;
  notes?: string[];
  /**
   * Minimum standard uncertainty, in the measure's unit.
   *
   * The Monte-Carlo propagation covers the errors we modelled. It cannot cover
   * the ones we did not: soft-tissue movement between a skin landmark and the
   * joint centre, the difference between the anatomical definition a study used
   * and the one a detector was trained on, the quantisation of an event to the
   * frame grid. Those are small but they are not zero, and without a floor the
   * system will occasionally report a timing to the microsecond and mean it.
   */
  sdFloor?: number;
}

/**
 * Weight of the worst trust factor when the factors are combined.
 *
 * At 0.5 the combined trust is the geometric mean of the factors and their
 * minimum, in equal measure.
 */
export const WORST_TRUST_WEIGHT = 0.5;

/**
 * Combines the trust factors of a measurement into one number in [0, 1].
 *
 * The factors used to be multiplied, and that was wrong in a way that took a
 * long time to see. Multiplication is the right form for independent
 * probabilities of survival — the chance that none of several separate faults
 * occurred. These factors are not that. They are graded qualities of one
 * measurement: how well the joints were seen, how sure the phase boundary is,
 * how good the reconstruction is, whether the depth direction is resolved.
 * Multiplying graded qualities makes the result fall off geometrically with the
 * *number* of qualities anyone thought to check, so a pipeline that examines
 * six aspects of its own work reports less confidence than one that examines
 * three and looks away — with the same underlying video. In this pipeline four
 * respectable factors (1.00, 0.90, 0.69, 0.50) produced 0.31, below every
 * threshold downstream, and nothing was ever quotable.
 *
 * The geometric mean removes that count dependence: all-0.8 gives 0.8, whatever
 * the length of the list. On its own it is too forgiving, because one collapsed
 * factor can be averaged away by good company — and a measurement whose depth
 * direction is unknown is not saved by clean joint detection. So the mean is
 * pulled halfway toward the worst factor. A single factor near zero still
 * drives the result to zero; several good ones now compound to a good one.
 *
 * This changes no interval. The spread of a measurement is the Monte-Carlo
 * result and is untouched; what changes is only the gate that decides whether
 * the number may be spoken aloud.
 */
export function combineTrust(factors: Array<{ value: number }>): number {
  if (factors.length === 0) return 1;
  const values = factors.map((f) => clamp(f.value, 0, 1));
  if (values.some((v) => v <= 0)) return 0;
  const logMean = values.reduce((s, v) => s + Math.log(v), 0) / values.length;
  const geometric = Math.exp(logMean);
  const worst = Math.min(...values);
  return clamp(
    Math.pow(worst, WORST_TRUST_WEIGHT) * Math.pow(geometric, 1 - WORST_TRUST_WEIGHT),
    0,
    1,
  );
}

export function measureFrom(mc: McResult, spec: MeasureSpec): Measure {
  const notes = [...(spec.notes ?? [])];
  const trust = combineTrust(spec.trust);

  if (mc.value === null) {
    return {
      value: null,
      sd: null,
      confidence: 0,
      unit: spec.unit,
      observability: spec.observability,
      provenance: spec.provenance,
      notes: [...notes, "Nicht berechenbar: zu wenige gültige Replikate in der Fehlerfortpflanzung."],
    };
  }

  // Replicas that failed to produce a value are themselves evidence of a
  // fragile measurement, so they reduce confidence rather than being ignored.
  const confidence = clamp(trust * mc.validFraction, 0, 1);
  for (const t of spec.trust) {
    if (t.value < 0.6) notes.push(`Eingeschränkt durch ${t.label} (${Math.round(t.value * 100)} %).`);
  }
  if (spec.observability === "depth_limited") {
    notes.push("Tiefenabhängige Größe: aus einer Kamera nur eingeschränkt bestimmbar.");
  }

  const sd = mc.sd === null ? null : Math.max(mc.sd, spec.sdFloor ?? 0);
  return {
    value: mc.value,
    sd,
    confidence,
    unit: spec.unit,
    observability: spec.observability,
    provenance: spec.provenance,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Reading measures                                                    */
/* ------------------------------------------------------------------ */

/** Symmetric coverage interval at the given level (default ~95 %). */
export function interval(m: Measure, k = 1.96): [number, number] | null {
  if (m.value === null || m.sd === null) return null;
  return [m.value - k * m.sd, m.value + k * m.sd];
}

/**
 * Probability that the true value lies beyond `threshold`, given the measure's
 * own uncertainty. Findings are gated on this rather than on the point
 * estimate, which is what stops "104° vs. an optimum of 110°" from ever
 * becoming a coaching statement when the measurement is worth +/- 20°.
 */
export function probabilityBeyond(m: Measure, threshold: number, direction: "above" | "below"): number | null {
  if (m.value === null || m.sd === null || m.sd <= 0) return null;
  const z = (threshold - m.value) / m.sd;
  return direction === "above" ? 1 - normalCdf(z) : normalCdf(z);
}

export type ConfidenceBand = "hoch" | "mittel" | "niedrig" | "unzureichend";

export function band(confidence: number): ConfidenceBand {
  if (confidence >= 0.8) return "hoch";
  if (confidence >= 0.6) return "mittel";
  if (confidence >= 0.35) return "niedrig";
  return "unzureichend";
}

/** A measure is quotable to a coach only above this confidence. */
export const QUOTABLE_CONFIDENCE = 0.35;
/** A measure may drive a *recommendation* only above this confidence. */
export const ACTIONABLE_CONFIDENCE = 0.6;

export const isQuotable = (m: Measure): boolean =>
  m.value !== null && m.confidence >= QUOTABLE_CONFIDENCE && m.observability !== "unobservable";

export const isActionable = (m: Measure): boolean =>
  m.value !== null && m.confidence >= ACTIONABLE_CONFIDENCE && m.observability !== "unobservable";

/** Formats a measure the way it is allowed to appear in the UI. */
export function formatMeasure(m: Measure, decimals = 1): string {
  if (m.value === null) return "nicht messbar";
  const v = m.value.toFixed(decimals);
  if (m.sd === null) return `${v} ${m.unit}`;
  return `${v} ± ${m.sd.toFixed(decimals)} ${m.unit}`;
}
