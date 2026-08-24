import { clamp, dist2, mad, median, smooth } from "../core/math.ts";
import {
  JOINTS,
  type FrameObservation,
  type Joint,
  type Keypoint2D,
  type LayerReport,
} from "../core/types.ts";
import { expectedBoneLengths, type Anthropometry } from "../fixtures/anthropometry.ts";
import { BONES } from "../core/types.ts";

/**
 * Layer 5 — Temporal tracking, outlier detection and gap filling.
 *
 * This is where the "the joint jumped 40 cm between two frames" requirement
 * lives. Every rejection is recorded rather than quietly repaired, because the
 * *rate* of rejections is itself the most informative quality signal the system
 * has: a clip with 2 % rejected samples and a clip with 25 % deserve very
 * different levels of confidence even if the surviving numbers look identical.
 */

export type OutlierKind =
  | "impossible_speed"
  | "spike"
  | "bone_length"
  | "limb_swap"
  | "dropout"
  | "low_score";

export interface Outlier {
  frame: number;
  joint: Joint;
  kind: OutlierKind;
  /** How far the sample was from what the neighbourhood predicted, in pixels. */
  residualPx: number;
}

export interface TrackingResult {
  report: LayerReport;
  frames: FrameObservation[];
  outliers: Outlier[];
  /** Per-joint temporal stability in [0, 1]. */
  stability: Partial<Record<Joint, number>>;
  /** Per-joint fraction of frames that survived cleaning. */
  coverage: Partial<Record<Joint, number>>;
  /** Frames whose values were interpolated across a gap. */
  interpolated: Array<{ frame: number; joint: Joint }>;
}

/**
 * Physiological speed ceilings in metres per second, by joint group.
 * A serving hand peaks near 12 m/s; a pelvis never exceeds about 4 m/s. Any
 * sample above these is a tracking failure, not an athletic feat.
 */
const MAX_SPEED_MS: Partial<Record<Joint, number>> = {
  wristL: 14,
  wristR: 14,
  handL: 16,
  handR: 16,
  elbowL: 10,
  elbowR: 10,
  ankleL: 9,
  ankleR: 9,
  footL: 10,
  footR: 10,
  kneeL: 7,
  kneeR: 7,
  head: 6,
  neck: 5,
  pelvis: 4.5,
  spine: 4.5,
  thorax: 5,
  sternum: 5,
  shoulderL: 6,
  shoulderR: 6,
  hipL: 5,
  hipR: 5,
};
const DEFAULT_MAX_SPEED_MS = 8;

/** Below this detector score a keypoint is not used as a measurement. */
export const MIN_USABLE_SCORE = 0.3;
/** Longest gap that may be bridged by interpolation, in frames. */
const MAX_INTERPOLATION_GAP = 3;

export interface TrackingOptions {
  /** Scene seconds per frame. */
  dtScene: number;
  focalPx: number;
  subjectDepthM: number | null;
  anthro: Anthropometry;
  /** Frames the detection layer flagged as a different subject. */
  identitySwitchFrames?: number[];
}

export function trackAndClean(input: FrameObservation[], opts: TrackingOptions): TrackingResult {
  // Deep copy down to the keypoints. The smoothing pass below rewrites `kp.p`
  // in place, and a shallow copy would leave those keypoint objects shared with
  // the caller's request — so analysing the same clip twice would smooth it
  // twice and return two different reports. Reproducibility is not a nicety
  // here: a coach who reopens yesterday's analysis has to see yesterday's
  // numbers.
  const frames: FrameObservation[] = input.map((f) => ({
    ...f,
    pose2d: Object.fromEntries(
      Object.entries(f.pose2d).map(([joint, kp]) => [joint, kp ? { ...kp, p: { ...kp.p } } : kp]),
    ) as FrameObservation["pose2d"],
    racket: f.racket ? { ...f.racket, grip: { ...f.racket.grip }, head: { ...f.racket.head } } : undefined,
    ball: f.ball ? { ...f.ball, p: { ...f.ball.p } } : undefined,
  }));
  const outliers: Outlier[] = [];
  const interpolated: Array<{ frame: number; joint: Joint }> = [];
  const notes: string[] = [];

  // Pixels per metre at the subject's depth; without it, speed limits cannot be
  // enforced in physical units and we fall back to a purely relative test.
  const pxPerM =
    opts.subjectDepthM && opts.subjectDepthM > 0 ? opts.focalPx / opts.subjectDepthM : null;

  // --- 1. Drop unusable detections -------------------------------------
  for (const f of frames) {
    for (const j of JOINTS) {
      const kp = f.pose2d[j];
      if (kp && kp.score < MIN_USABLE_SCORE) {
        outliers.push({ frame: f.index, joint: j, kind: "low_score", residualPx: 0 });
        delete f.pose2d[j];
      }
    }
  }

  // --- 2. Limb-swap detection ------------------------------------------
  // A left/right swap keeps every individual joint plausible while destroying
  // every asymmetric measurement. It shows up as both sides jumping toward each
  // other's previous position at the same instant.
  const swapBases = ["shoulder", "elbow", "wrist", "hand", "hip", "knee", "ankle", "foot"] as const;
  const swapFrames = new Set<number>();
  for (let i = 1; i < frames.length; i++) {
    let straight = 0;
    let crossed = 0;
    let n = 0;
    for (const b of swapBases) {
      const lPrev = frames[i - 1].pose2d[`${b}L` as Joint];
      const rPrev = frames[i - 1].pose2d[`${b}R` as Joint];
      const lNow = frames[i].pose2d[`${b}L` as Joint];
      const rNow = frames[i].pose2d[`${b}R` as Joint];
      if (!lPrev || !rPrev || !lNow || !rNow) continue;
      straight += dist2(lPrev.p, lNow.p) + dist2(rPrev.p, rNow.p);
      crossed += dist2(lPrev.p, rNow.p) + dist2(rPrev.p, lNow.p);
      n++;
    }
    // Require a clear margin: limbs genuinely cross during a serve, so a small
    // advantage for the swapped assignment proves nothing.
    if (n >= 4 && crossed < straight * 0.55) swapFrames.add(i);
  }
  // Swaps come in runs; correct the whole run by re-swapping.
  if (swapFrames.size > 0) {
    let inRun = false;
    for (let i = 1; i < frames.length; i++) {
      if (swapFrames.has(i)) inRun = !inRun;
      if (inRun) {
        for (const b of swapBases) {
          const l = `${b}L` as Joint;
          const r = `${b}R` as Joint;
          const tmp = frames[i].pose2d[l];
          frames[i].pose2d[l] = frames[i].pose2d[r];
          frames[i].pose2d[r] = tmp;
          outliers.push({ frame: frames[i].index, joint: l, kind: "limb_swap", residualPx: 0 });
        }
      }
    }
    notes.push(
      `Links/Rechts-Vertauschung in ${swapFrames.size} Übergängen erkannt und korrigiert. ` +
        "Seitenabhängige Größen sind dadurch weniger sicher.",
    );
  }

  // --- 3. Speed and spike rejection ------------------------------------
  for (const j of JOINTS) {
    const maxSpeed = MAX_SPEED_MS[j] ?? DEFAULT_MAX_SPEED_MS;
    const maxPxPerFrame = pxPerM ? maxSpeed * opts.dtScene * pxPerM : null;

    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1].pose2d[j];
      const now = frames[i].pose2d[j];
      if (!prev || !now) continue;
      const step = dist2(prev.p, now.p);
      if (maxPxPerFrame !== null && step > maxPxPerFrame) {
        outliers.push({ frame: frames[i].index, joint: j, kind: "impossible_speed", residualPx: step });
        delete frames[i].pose2d[j];
      }
    }

    // Spike test: a sample that disagrees with a local median by many robust
    // deviations is a detection error, not motion. Motion is smooth; errors are
    // not.
    const xs = frames.map((f) => f.pose2d[j]?.p.x ?? NaN);
    const ys = frames.map((f) => f.pose2d[j]?.p.y ?? NaN);
    const resid: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].pose2d[j]) {
        resid.push(NaN);
        continue;
      }
      const wx: number[] = [];
      const wy: number[] = [];
      for (let k = -3; k <= 3; k++) {
        const idx = i + k;
        if (k === 0 || idx < 0 || idx >= frames.length) continue;
        if (Number.isFinite(xs[idx])) {
          wx.push(xs[idx]);
          wy.push(ys[idx]);
        }
      }
      if (wx.length < 4) {
        resid.push(NaN);
        continue;
      }
      resid.push(Math.hypot(xs[i] - (median(wx) as number), ys[i] - (median(wy) as number)));
    }
    const finite = resid.filter((r) => Number.isFinite(r));
    const scale = mad(finite) ?? 0;
    if (scale > 1e-6) {
      const cut = Math.max(6 * scale, 6);
      for (let i = 0; i < frames.length; i++) {
        if (Number.isFinite(resid[i]) && resid[i] > cut) {
          outliers.push({ frame: frames[i].index, joint: j, kind: "spike", residualPx: resid[i] });
          delete frames[i].pose2d[j];
        }
      }
    }
  }

  // --- 4. Bone-length plausibility in image space ----------------------
  // A projected bone can never be longer than the true bone; when it is, one of
  // the two endpoints is wrong.
  if (pxPerM) {
    const expected = expectedBoneLengths(opts.anthro);
    for (const f of frames) {
      for (const [p, q] of BONES) {
        const L = expected[`${p}-${q}`];
        const a = f.pose2d[p];
        const b = f.pose2d[q];
        if (!L || !a || !b) continue;
        const lengthM = dist2(a.p, b.p) / pxPerM;
        if (lengthM > L * 1.35) {
          outliers.push({
            frame: f.index,
            joint: q,
            kind: "bone_length",
            residualPx: (lengthM - L) * pxPerM,
          });
          // The distal joint is the more likely offender.
          delete f.pose2d[q];
        }
      }
    }
  }

  // --- 5. Short-gap interpolation --------------------------------------
  for (const j of JOINTS) {
    let i = 0;
    while (i < frames.length) {
      if (frames[i].pose2d[j]) {
        i++;
        continue;
      }
      let end = i;
      while (end < frames.length && !frames[end].pose2d[j]) end++;
      const gap = end - i;
      const before = i > 0 ? frames[i - 1].pose2d[j] : undefined;
      const after = end < frames.length ? frames[end].pose2d[j] : undefined;
      if (before && after && gap <= MAX_INTERPOLATION_GAP) {
        for (let k = 0; k < gap; k++) {
          const t = (k + 1) / (gap + 1);
          frames[i + k].pose2d[j] = {
            p: {
              x: before.p.x + (after.p.x - before.p.x) * t,
              y: before.p.y + (after.p.y - before.p.y) * t,
            },
            // Interpolated samples never carry the confidence of measured ones.
            score: Math.min(before.score, after.score) * (0.75 - 0.1 * gap),
            occluded: true,
          };
          interpolated.push({ frame: frames[i + k].index, joint: j });
        }
      } else if (gap > MAX_INTERPOLATION_GAP) {
        for (let k = 0; k < gap; k++) {
          outliers.push({ frame: frames[i + k].index, joint: j, kind: "dropout", residualPx: 0 });
        }
      }
      i = end === i ? i + 1 : end;
    }
  }

  // --- 6. Zero-phase smoothing -----------------------------------------
  // Half-width one: enough to suppress per-frame detector jitter, short enough
  // not to shift or flatten the peaks the timing analysis depends on.
  for (const j of JOINTS) {
    const idx: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      const kp = frames[i].pose2d[j];
      if (kp) {
        idx.push(i);
        xs.push(kp.p.x);
        ys.push(kp.p.y);
      }
    }
    if (idx.length < 5) continue;
    const sx = smooth(xs, 1);
    const sy = smooth(ys, 1);
    for (let k = 0; k < idx.length; k++) {
      const kp = frames[idx[k]].pose2d[j] as Keypoint2D;
      kp.p = { x: sx[k], y: sy[k] };
    }
  }

  // --- Quality summary -------------------------------------------------
  const stability: Partial<Record<Joint, number>> = {};
  const coverage: Partial<Record<Joint, number>> = {};
  for (const j of JOINTS) {
    const present = frames.filter((f) => f.pose2d[j]).length;
    coverage[j] = frames.length ? present / frames.length : 0;
    const rejected = outliers.filter((o) => o.joint === j).length;
    stability[j] = frames.length ? clamp(1 - rejected / frames.length, 0, 1) : 0;
  }

  const totalRejected = outliers.length;
  const rejectionRate = frames.length ? totalRejected / (frames.length * JOINTS.length) : 0;
  if (rejectionRate > 0.03) {
    notes.push(
      `${(rejectionRate * 100).toFixed(1)} % aller Gelenk-Stichproben wurden als fehlerhaft verworfen.`,
    );
  }
  if (interpolated.length) {
    notes.push(`${interpolated.length} Stichproben über kurze Lücken interpoliert (reduzierte Sicherheit).`);
  }
  for (const f of opts.identitySwitchFrames ?? []) {
    notes.push(`Bild ${f}: möglicher Spielerwechsel im Track.`);
  }

  const quality = clamp(1 - rejectionRate * 6, 0, 1);
  return {
    report: {
      id: "L5",
      name: "Temporales Tracking & Ausreißererkennung",
      status: rejectionRate < 0.02 ? "ok" : rejectionRate < 0.12 ? "degraded" : "failed",
      quality,
      notes,
      diagnostics: {
        verworfeneStichproben: totalRejected,
        verwerfungsrateProzent: Number((rejectionRate * 100).toFixed(2)),
        interpoliert: interpolated.length,
        limbSwapUebergaenge: swapFrames.size,
        unmoeglicheGeschwindigkeit: outliers.filter((o) => o.kind === "impossible_speed").length,
        spitzen: outliers.filter((o) => o.kind === "spike").length,
        knochenlaenge: outliers.filter((o) => o.kind === "bone_length").length,
      },
    },
    frames,
    outliers,
    stability,
    coverage,
    interpolated,
  };
}
