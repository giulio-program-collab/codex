import { JOINTS } from "../core/types.ts";
import type { ServeTruth } from "./serve-model.ts";

/**
 * Ground-truth accuracy of a reconstruction, in metres.
 *
 * The reconstruction lives in its own frame: a single camera cannot fix the
 * absolute rotation of the scene about the vertical, so comparing it to the
 * truth directly would measure the arbitrary choice of axis rather than the
 * reconstruction. The error is therefore root-relative and evaluated at the
 * best-fitting yaw, which is exactly what the measurement layer needs to be
 * right about — angles, lengths and timings are all invariant to that rotation.
 */
export function rootRelativeJointErrorM(
  reconstructed: Array<Record<string, { p: { x: number; y: number; z: number } } | undefined>>,
  truth: ServeTruth,
  fps: number,
): number {
  const truthHz = truth.frames.length > 1 ? 1 / (truth.frames[1].t - truth.frames[0].t) : 240;

  const errorAtYaw = (degrees: number, step: number): number => {
    const c = Math.cos((degrees * Math.PI) / 180);
    const s = Math.sin((degrees * Math.PI) / 180);
    let total = 0;
    let count = 0;
    for (let i = 0; i < reconstructed.length; i += step) {
      const truthIndex = Math.min(truth.frames.length - 1, Math.round((i / fps) * truthHz));
      const t = truth.frames[truthIndex];
      const root = reconstructed[i]?.pelvis?.p;
      if (!root) continue;
      for (const j of JOINTS) {
        const r = reconstructed[i]?.[j]?.p;
        if (!r) continue;
        const dx = r.x - root.x;
        const dy = r.y - root.y;
        const dz = r.z - root.z;
        const rx = c * dx - s * dy;
        const ry = s * dx + c * dy;
        const tx = t.joints[j].x - t.joints.pelvis.x;
        const ty = t.joints[j].y - t.joints.pelvis.y;
        const tz = t.joints[j].z - t.joints.pelvis.z;
        total += Math.hypot(rx - tx, ry - ty, dz - tz);
        count++;
      }
    }
    return count > 0 ? total / count : Number.POSITIVE_INFINITY;
  };

  let best = Number.POSITIVE_INFINITY;
  let bestYaw = 0;
  for (let d = -180; d < 180; d += 2) {
    const e = errorAtYaw(d, 4);
    if (e < best) {
      best = e;
      bestYaw = d;
    }
  }
  // Refine, then evaluate on every frame.
  for (let d = bestYaw - 2; d <= bestYaw + 2; d += 0.25) {
    const e = errorAtYaw(d, 4);
    if (e < best) {
      best = e;
      bestYaw = d;
    }
  }
  return errorAtYaw(bestYaw, 1);
}
