import { Rng, clamp, dist3, dot3, sub3, unit3, v3 } from "../core/math.ts";
import { type PinholeCamera, focalFromHfov, lookAt, project } from "../core/camera.ts";
import { JOINTS, JOINT_SOURCE, type FrameObservation, type Joint, type Pose2D, type VideoMeta } from "../core/types.ts";
import type { ServeTruth } from "./serve-model.ts";

/**
 * Turns ground truth into the kind of imperfect 2D observations a real pose
 * estimator emits: pixel noise that grows with motion blur, confidence that
 * drops with self-occlusion, dropped joints, and — the failure mode that
 * silently poisons every downstream number — the occasional left/right swap.
 */

export interface CameraRig {
  /** Placement in metres, world frame (x lateral, y toward the net, z up). */
  position: { x: number; y: number; z: number };
  /** Point the camera is aimed at. */
  target: { x: number; y: number; z: number };
  hfovDeg: number;
  widthPx: number;
  heightPx: number;
}

export const CAMERA_RIGS: Record<string, CameraRig> = {
  /** Coach standing behind and slightly beside the server — the common phone shot. */
  behind: {
    position: { x: 1.2, y: -6.5, z: 1.6 },
    target: { x: 0, y: 0, z: 1.5 },
    hfovDeg: 62,
    widthPx: 1920,
    heightPx: 1080,
  },
  /** Side-on from the fence, the view the biomechanics literature assumes. */
  side: {
    position: { x: 8.5, y: -0.6, z: 1.5 },
    target: { x: 0, y: 0, z: 1.5 },
    hfovDeg: 52,
    widthPx: 1920,
    heightPx: 1080,
  },
  /** Diagonal, the most common accidental angle. */
  diagonal: {
    position: { x: 6.0, y: -6.0, z: 1.7 },
    target: { x: 0, y: 0, z: 1.5 },
    hfovDeg: 58,
    widthPx: 1920,
    heightPx: 1080,
  },
  /** From the receiver's end, facing the server. */
  front: {
    position: { x: -0.8, y: 11.0, z: 1.7 },
    target: { x: 0, y: 0, z: 1.6 },
    hfovDeg: 48,
    widthPx: 1920,
    heightPx: 1080,
  },
  /** Elevated side view, closest to a laboratory setup. */
  elevatedSide: {
    position: { x: 9.0, y: -1.0, z: 3.6 },
    target: { x: 0, y: 0, z: 1.7 },
    hfovDeg: 50,
    widthPx: 1920,
    heightPx: 1080,
  },
};

export function cameraFromRig(rig: CameraRig): PinholeCamera {
  return lookAt(
    v3(rig.position.x, rig.position.y, rig.position.z),
    v3(rig.target.x, rig.target.y, rig.target.z),
    focalFromHfov(rig.hfovDeg, rig.widthPx),
    rig.widthPx,
    rig.heightPx,
  );
}

export interface RenderOptions {
  rig: CameraRig;
  /** Frame rate of the produced clip. */
  fps: number;
  /** Rate the scene was captured at (>= fps for slow motion). */
  captureFps?: number;
  /** 1-sigma keypoint noise in pixels at rest. */
  noisePx?: number;
  /** Extra noise proportional to image-space joint speed (px per px/frame). */
  blurNoiseFactor?: number;
  /** Probability that a joint is dropped entirely in a frame. */
  dropoutRate?: number;
  /** Frames in which the player is behind an obstacle; joints inside are lost. */
  occlusionWindows?: Array<{ startS: number; endS: number; joints: Joint[] }>;
  /** Inject a left/right limb swap over this window, the classic tracker failure. */
  limbSwapWindow?: { startS: number; endS: number };
  /** Inject a single-frame position jump of this size in pixels. */
  jumpInjection?: { atS: number; joint: Joint; px: number };
  /** Whether racket observations are produced at all. */
  racket?: boolean;
  /** Whether ball observations are produced at all. */
  ball?: boolean;
  /** Detector score for well-seen joints. */
  baseScore?: number;
  seed?: number;
}

export interface RenderedClip {
  video: VideoMeta;
  camera: PinholeCamera;
  frames: FrameObservation[];
  truth: ServeTruth;
}

export function renderClip(truth: ServeTruth, opts: RenderOptions): RenderedClip {
  const rng = new Rng(opts.seed ?? 20260824);
  const cam = cameraFromRig(opts.rig);
  const fps = opts.fps;
  const captureFps = opts.captureFps ?? fps;
  const noisePx = opts.noisePx ?? 2.5;
  const blurFactor = opts.blurNoiseFactor ?? 0.35;
  const dropout = opts.dropoutRate ?? 0.01;
  const baseScore = opts.baseScore ?? 0.92;

  // Truth is sampled continuously, so we resample it at the requested rate.
  const nFrames = Math.max(2, Math.round(truth.params.durationS * fps));
  const timeScale = captureFps / fps; // slow-motion playback stretches time
  const frames: FrameObservation[] = [];
  let prev: Record<string, { x: number; y: number }> = {};

  for (let i = 0; i < nFrames; i++) {
    const tPlayback = i / fps;
    const tScene = tPlayback * (fps / captureFps) * timeScale; // identity by construction; kept explicit
    const truthFrame = interpolateTruth(truth, tScene);
    const pose2d: Pose2D = {};

    for (const joint of JOINTS) {
      const world = truthFrame.joints[joint];
      const pr = project(cam, world);
      if (!pr.inFrame) continue;

      // Self-occlusion: a joint whose limb points along the optical axis and
      // that sits behind the torso is what real detectors get wrong.
      const occScore = selfOcclusionScore(truthFrame.joints, joint, cam);
      let score = clamp(baseScore * occScore, 0.02, 0.99);
      // Derived joints are never observed by a detector; the skeleton model
      // will reconstruct them, so they are not emitted here.
      if (JOINT_SOURCE[joint] === "derived") continue;

      let dropped = rng.next() < dropout;
      for (const w of opts.occlusionWindows ?? []) {
        if (tPlayback >= w.startS && tPlayback <= w.endS && w.joints.includes(joint)) dropped = true;
      }
      if (dropped) continue;

      const speedPx = prev[joint] ? Math.hypot(pr.p.x - prev[joint].x, pr.p.y - prev[joint].y) : 0;
      const sigma = noisePx + blurFactor * speedPx;
      const p = { x: pr.p.x + rng.gauss(0, sigma), y: pr.p.y + rng.gauss(0, sigma) };
      // Fast, blurred joints also lose detector confidence in practice.
      score = clamp(score * (1 - clamp(speedPx / 260, 0, 0.55)), 0.02, 0.99);
      pose2d[joint] = { p, score, occluded: occScore < 0.5 };
      prev[joint] = pr.p;
    }

    if (opts.limbSwapWindow && tPlayback >= opts.limbSwapWindow.startS && tPlayback <= opts.limbSwapWindow.endS) {
      swapSides(pose2d, ["shoulder", "elbow", "wrist", "hip", "knee", "ankle", "foot"]);
    }
    if (opts.jumpInjection && Math.abs(tPlayback - opts.jumpInjection.atS) < 0.5 / fps) {
      const kp = pose2d[opts.jumpInjection.joint];
      if (kp) kp.p = { x: kp.p.x + opts.jumpInjection.px, y: kp.p.y - opts.jumpInjection.px * 0.6 };
    }

    const frame: FrameObservation = { index: i, t: tPlayback, pose2d };

    if (opts.racket !== false) {
      const g = project(cam, truthFrame.racketGrip);
      const h = project(cam, truthFrame.racketHead);
      if (g.inFrame && h.inFrame) {
        const speed = Math.hypot(h.p.x - (prev["racketHead"]?.x ?? h.p.x), h.p.y - (prev["racketHead"]?.y ?? h.p.y));
        const sig = noisePx * 1.6 + blurFactor * speed * 1.4;
        frame.racket = {
          grip: { x: g.p.x + rng.gauss(0, sig * 0.6), y: g.p.y + rng.gauss(0, sig * 0.6) },
          head: { x: h.p.x + rng.gauss(0, sig), y: h.p.y + rng.gauss(0, sig) },
          score: clamp(0.9 * (1 - clamp(speed / 320, 0, 0.75)), 0.03, 0.97),
        };
        prev["racketHead"] = h.p;
      }
    }

    if (opts.ball !== false && truthFrame.ball) {
      const b = project(cam, truthFrame.ball);
      if (b.inFrame) {
        const speed = Math.hypot(b.p.x - (prev["ball"]?.x ?? b.p.x), b.p.y - (prev["ball"]?.y ?? b.p.y));
        // A tennis ball travelling at 190 km/h smears across 40+ pixels in a
        // 1/250 s exposure; detectors lose it entirely just after contact.
        const visible = speed < 90 || rng.next() < 0.25;
        if (visible) {
          frame.ball = {
            p: { x: b.p.x + rng.gauss(0, noisePx * 1.2), y: b.p.y + rng.gauss(0, noisePx * 1.2) },
            radiusPx: clamp((0.033 * cam.focalPx) / Math.max(0.5, b.depthM), 1, 40),
            score: clamp(0.85 * (1 - clamp(speed / 140, 0, 0.9)), 0.02, 0.95),
          };
        }
        prev["ball"] = b.p;
      }
    }

    frames.push(frame);
  }

  return {
    video: {
      fps,
      captureFps,
      widthPx: opts.rig.widthPx,
      heightPx: opts.rig.heightPx,
      durationS: truth.params.durationS,
      hfovDeg: opts.rig.hfovDeg,
    },
    camera: cam,
    frames,
    truth,
  };
}

/** Linear interpolation of the truth sequence at an arbitrary time. */
function interpolateTruth(truth: ServeTruth, t: number) {
  const fs = truth.frames;
  if (t <= fs[0].t) return fs[0];
  if (t >= fs[fs.length - 1].t) return fs[fs.length - 1];
  let i = 0;
  while (i < fs.length - 2 && fs[i + 1].t < t) i++;
  const a = fs[i];
  const b = fs[i + 1];
  const u = (t - a.t) / (b.t - a.t);
  const joints = {} as Record<Joint, { x: number; y: number; z: number }>;
  for (const j of JOINTS) {
    joints[j] = {
      x: a.joints[j].x + (b.joints[j].x - a.joints[j].x) * u,
      y: a.joints[j].y + (b.joints[j].y - a.joints[j].y) * u,
      z: a.joints[j].z + (b.joints[j].z - a.joints[j].z) * u,
    };
  }
  const mixv = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => ({
    x: p.x + (q.x - p.x) * u,
    y: p.y + (q.y - p.y) * u,
    z: p.z + (q.z - p.z) * u,
  });
  return {
    ...a,
    t,
    joints,
    racketGrip: mixv(a.racketGrip, b.racketGrip),
    racketHead: mixv(a.racketHead, b.racketHead),
    ball: a.ball && b.ball ? mixv(a.ball, b.ball) : (b.ball ?? a.ball),
  };
}

/**
 * Crude but effective self-occlusion proxy: a joint is hard to see when the
 * torso lies between it and the camera.
 */
function selfOcclusionScore(
  joints: Record<Joint, { x: number; y: number; z: number }>,
  joint: Joint,
  cam: PinholeCamera,
): number {
  const p = joints[joint];
  const torso = joints.thorax;
  const toCam = unit3(sub3(cam.position, p));
  const toTorso = sub3(torso, p);
  const along = dot3(toTorso, toCam);
  if (along <= 0) return 1;
  const lateral = Math.sqrt(Math.max(0, dist3(torso, p) ** 2 - along * along));
  // Within ~18 cm of the line of sight through the torso the joint is hidden.
  return clamp(lateral / 0.18, 0.25, 1);
}

function swapSides(pose: Pose2D, bases: string[]): void {
  for (const b of bases) {
    const l = `${b}L` as Joint;
    const r = `${b}R` as Joint;
    const tmp = pose[l];
    pose[l] = pose[r];
    pose[r] = tmp;
  }
}

