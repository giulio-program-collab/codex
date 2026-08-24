import { Rng, dot3, sub3 } from "../core/math.ts";
import type { PinholeCamera } from "../core/camera.ts";
import type { Joint } from "../core/types.ts";
import type { DepthPrior } from "../layers/l06-lift3d.ts";
import type { ServeTruth } from "./serve-model.ts";

/**
 * A stand-in for a learned monocular depth model, for validation only.
 *
 * It answers the question the geometric lift cannot answer on its own: *if* a
 * learned lift supplied per-joint depth at a stated accuracy, what would the
 * rest of the pipeline then be able to say? That is a question the downstream
 * layers must be tested against, because their thresholds — which reference
 * comparisons are informative, which findings clear the confidence floor — all
 * depend on it, and they should not be tuned against the weakest possible
 * front end.
 *
 * It is deliberately confined to the fixtures directory and takes ground truth
 * as an input, so it cannot be reached from any production path. The accuracy
 * figure is the parameter: published monocular 3D pose estimators report
 * roughly 35-50 mm mean per-joint position error on Human3.6M after alignment,
 * and tennis serves are far outside that dataset's distribution, so anything
 * below about 40 mm here would be an optimistic claim rather than a test.
 */
export const REALISTIC_LEARNED_LIFT_SIGMA_M = 0.055;

export function simulatedLearnedDepthPrior(
  truth: ServeTruth,
  cam: PinholeCamera,
  frameTimes: number[],
  sigmaM: number = REALISTIC_LEARNED_LIFT_SIGMA_M,
  seed = 991,
): DepthPrior {
  const rng = new Rng(seed);
  const cache = new Map<string, number>();

  const truthAt = (index: number) => {
    const t = frameTimes[index] ?? 0;
    const frames = truth.frames;
    const i = Math.max(0, Math.min(frames.length - 1, Math.round((t / truth.params.durationS) * (frames.length - 1))));
    return frames[i];
  };

  return {
    id: `simuliert:lernbasiert(sigma=${Math.round(sigmaM * 1000)}mm)`,
    depthM(frameIndex: number, joint: Joint): number | null {
      const key = `${frameIndex}|${joint}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const frame = truthAt(frameIndex);
      const p = frame?.joints[joint];
      if (!p) return null;
      const depth = dot3(sub3(p, cam.position), cam.forward) + rng.gauss(0, sigmaM);
      cache.set(key, depth);
      return depth;
    },
    sigmaM(): number {
      return sigmaM;
    },
  };
}
