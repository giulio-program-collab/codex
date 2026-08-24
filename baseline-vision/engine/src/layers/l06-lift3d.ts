import {
  type Vec3,
  add3,
  butterworthLowPass,
  clamp,
  cross3,
  dist2,
  dot3,
  mean,
  median,
  norm3,
  quantile,
  scale3,
  smooth,
  sub3,
  unit3,
  v3,
} from "../core/math.ts";
import { backproject, type PinholeCamera } from "../core/camera.ts";
import { scatterMatrix, symmetricEigen3 } from "../core/linalg.ts";
import {
  BONES,
  JOINTS,
  type FrameObservation,
  type Joint,
  type Keypoint3D,
  type LayerReport,
  type Pose3D,
} from "../core/types.ts";
import { expectedBoneLengths, fallbackBoneLengths, type Anthropometry } from "../fixtures/anthropometry.ts";

/**
 * Layer 6 — Monocular 3D reconstruction.
 *
 * The reconstruction is a constrained depth propagation, not a learned lift.
 * Every joint lies on a known ray; every bone has a known metric length; given
 * the depth of one endpoint the depth of the other follows from
 *
 *     t_child = t_parent * cos(theta)  ±  sqrt( L^2 - t_parent^2 * sin^2(theta) )
 *
 * where theta is the angular separation of the two rays. Two properties of that
 * expression carry the whole honesty of the system:
 *
 *  1. The ± is the classic depth ambiguity. It is resolved by temporal
 *     continuity, and where continuity is weak the ambiguity is reported, not
 *     hidden.
 *
 *  2. The derivative of the square root with respect to the in-plane separation
 *     blows up as the bone approaches the image plane. That is not a numerical
 *     nuisance, it is the physics: a segment lying in the image plane has an
 *     unrecoverable depth sign, and a segment pointing at the camera has an
 *     unrecoverable in-plane angle. The old tool treated both cases as if they
 *     were a clean laboratory measurement.
 *
 * A learned lift (VideoPose3D, MotionBERT, a SMPL-based mesh recovery) would be
 * a drop-in replacement for the point estimate here and would be more accurate
 * on ordinary poses. It would not replace the uncertainty model: it would need
 * to supply the same per-joint covariance, which is exactly the thing such
 * models are usually not asked for.
 */

export interface Lift3DResult {
  report: LayerReport;
  /** Poses in the court frame: x lateral, y toward the target, z up. */
  poses: Pose3D[];
  /** Camera expressed in the court frame, for uncertainty propagation. */
  cameraInCourt: PinholeCamera;
  /** Estimated distance from camera to pelvis, per frame. */
  rootDepthM: number[];
  /** Height of the court plane in reconstruction units (should be ~0 after alignment). */
  groundZ: number;
  /** Confidence that the vertical axis was recovered correctly. */
  verticalConfidence: number;
  /**
   * Confidence that the depth direction (and hence every rotation sign) is the
   * right way round rather than mirrored. Low values disable every signed
   * quantity downstream.
   */
  mirrorConfidence: number;
  /** Confidence that the target ("toward the net") direction was recovered. */
  targetDirConfidence: number;
  /**
   * Relative uncertainty of the reconstruction's overall scale, common to every
   * joint. Applies to absolute lengths; cancels in angles and in ratios taken
   * against the player's own dimensions.
   */
  scaleRelSd: number;
  /** Mean absolute bone-length residual in metres, over all frames and bones. */
  boneResidualM: number;
  /** Fraction of bone solves whose discriminant was negative (geometrically impossible). */
  impossibleFraction: number;
}

interface TreeEdge {
  parent: Joint;
  child: Joint;
  lengthM: number;
  /** False for the redundant edges used only when the primary route is broken. */
  primary: boolean;
}

interface SkeletonGraph {
  adjacency: Map<Joint, Array<{ to: Joint; lengthM: number; primary: boolean }>>;
}

/**
 * Adjacency over the anatomical bones plus a few redundant connections.
 *
 * The spanning tree is then rebuilt *per frame* over the joints that frame
 * actually has. A fixed tree computed once would lose both arms whenever the
 * neck happens to be missing, which is not a hypothetical: derived trunk joints
 * are exactly the ones that disappear when a shoulder or a hip drops out.
 */
function buildGraph(expected: Record<string, number>, fallback: Record<string, number>): SkeletonGraph {
  const adjacency = new Map<Joint, Array<{ to: Joint; lengthM: number; primary: boolean }>>();
  const link = (a: Joint, b: Joint, lengthM: number, primary: boolean) => {
    if (!Number.isFinite(lengthM) || lengthM <= 0) return;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a)!.push({ to: b, lengthM, primary });
    adjacency.get(b)!.push({ to: a, lengthM, primary });
  };
  for (const [a, b] of BONES) {
    // The contralateral half-girdle edges are demoted: reaching the right hip
    // through the pelvis makes the pelvis *azimuth* the difference of two
    // independently estimated half-width depths, which doubles its noise. The
    // girdle spans below give the same information over twice the baseline.
    const demoted = (a === "pelvis" && b === "hipR") || (a === "neck" && b === "shoulderR");
    link(a, b, expected[`${a}-${b}`], !demoted);
  }
  for (const [key, L] of Object.entries(fallback)) {
    const [a, b] = key.split("-") as [Joint, Joint];
    link(a, b, L, false);
  }
  // Search order: the girdle spans first, then real bones, then the redundant
  // connections that only matter when something is missing.
  const rank = (e: { to: Joint; primary: boolean }, from: Joint): number => {
    const span =
      (from === "hipL" && e.to === "hipR") ||
      (from === "hipR" && e.to === "hipL") ||
      (from === "shoulderL" && e.to === "shoulderR") ||
      (from === "shoulderR" && e.to === "shoulderL");
    if (span) return 0;
    return e.primary ? 1 : 2;
  };
  for (const [from, list] of adjacency) list.sort((x, y) => rank(x, from) - rank(y, from));
  return { adjacency };
}

/** Spanning tree over the joints present in one frame, rooted at the pelvis. */
function frameTree(graph: SkeletonGraph, present: (j: Joint) => boolean): TreeEdge[] {
  const root: Joint = present("pelvis") ? "pelvis" : present("sternum") ? "sternum" : ("hipL" as Joint);
  if (!present(root)) return [];
  const edges: TreeEdge[] = [];
  const seen = new Set<Joint>([root]);
  const queue: Joint[] = [root];
  while (queue.length) {
    const cur = queue.shift() as Joint;
    for (const e of graph.adjacency.get(cur) ?? []) {
      if (seen.has(e.to) || !present(e.to)) continue;
      seen.add(e.to);
      edges.push({ parent: cur, child: e.to, lengthM: e.lengthM, primary: e.primary });
      queue.push(e.to);
    }
  }
  return edges;
}

/**
 * Low-pass cutoff applied to the reconstructed depth channel, in Hz.
 * Chosen above the fastest genuine trunk and limb motion in a serve so that the
 * filter removes noise without displacing the racket drop or the contact.
 */
export const DEPTH_CUTOFF_HZ = 14;

/**
 * How far above its lowest observed position a foot joint may sit and still
 * count as touching the court, in metres. Wide enough to survive the
 * reconstruction's own depth error, narrow enough to exclude the airborne phase
 * of a serve.
 */
export const GROUND_CONTACT_BAND_M = 0.07;

/**
 * Residual shape uncertainty of the root joint, as a fraction of body height,
 * when no depth prior pins it down. The root's absolute distance error is
 * common-mode and is carried as `scaleRelSd`; what remains here is the part
 * that genuinely distorts the reconstruction, through the bone-length
 * discriminant.
 */
export const ROOT_SHAPE_SIGMA_FRACTION = 0.02;

/**
 * How much of a joint's depth uncertainty survives the temporal filter.
 * The independent part is suppressed by roughly the square root of the number
 * of samples inside the filter's effective window; the correlated part (scale,
 * focal length, bone-length priors) is untouched. This factor is the empirical
 * combination of the two on the synthetic validation suite and must be
 * re-derived against real motion-capture ground truth before it is trusted on
 * real footage.
 */
export const DEPTH_FILTER_GAIN = 0.62;

/** Detector score to 1-sigma image-space localisation error, in pixels. */
export function pixelSigmaFromScore(score: number, imageShortSidePx: number): number {
  const base = imageShortSidePx / 480; // scale with resolution
  return base * (1.6 + 14 * (1 - clamp(score, 0, 1)) ** 2);
}

/**
 * A per-frame, per-joint depth prior with its own uncertainty.
 *
 * This is the extension point for a learned monocular lift. The geometric solve
 * in this layer is honest but weak: it knows bone lengths and rays and nothing
 * else, so a limb lying in the image plane leaves it with a genuinely
 * unresolvable sign and a wide posterior. A learned model — VideoPose3D,
 * MotionBERT, a SMPL-based mesh recovery — resolves exactly that ambiguity,
 * because it has seen what human bodies do and knows which of the two
 * geometrically valid configurations people actually adopt.
 *
 * What such a model must supply to be usable here is not a point estimate but a
 * point estimate *and a per-joint uncertainty*. Networks are usually not asked
 * for the second, which is why this interface makes it mandatory: a prior
 * without a sigma cannot be combined with a measurement, only substituted for
 * it, and substituting a confident guess for a measurement is how the old
 * system got into trouble.
 *
 * The two are combined by inverse-variance weighting, so the prior dominates
 * exactly where the geometry is ambiguous and defers where it is not.
 */
export interface DepthPrior {
  /** Depth along the camera axis for a joint in a frame, metres, or null. */
  depthM(frameIndex: number, joint: Joint): number | null;
  /** 1-sigma uncertainty of that depth, metres. */
  sigmaM(frameIndex: number, joint: Joint): number;
  /** Identifier recorded in the report so a reader knows what produced it. */
  id: string;
}

export interface LiftOptions {
  camera: PinholeCamera;
  anthro: Anthropometry;
  subjectDepthM: number | null;
  subjectDepthRelSd: number;
  /** Frame index of ball/racket contact, if already known; used for the target axis. */
  contactFrame?: number;
  dtScene: number;
  /** Optional learned depth prior; see `DepthPrior`. */
  depthPrior?: DepthPrior;
}

export function lift3D(frames: FrameObservation[], opts: LiftOptions): Lift3DResult {
  const notes: string[] = [];
  const cam = opts.camera;
  const expected = expectedBoneLengths(opts.anthro);
  const graph = buildGraph(expected, fallbackBoneLengths(opts.anthro));
  const shortSide = Math.min(cam.widthPx, cam.heightPx);

  // --- 1. Per-frame root depth -----------------------------------------
  // A bone of true length L whose image is l_px long satisfies
  //     p = l_px * d / f = L * cos(phi)  <=  L,
  // so every bone gives an upper bound d <= f * L / l_px, and the bound is
  // tight for whichever bone happens to lie in the image plane.
  //
  // Getting this scale right matters far more than it looks. For a bone that is
  // nearly in the image plane, the inferred out-of-plane fraction is
  // sqrt(1 - (p/L)^2), whose derivative with respect to the scale is infinite
  // at p = L: a 5 % under-estimate of the distance invents an out-of-plane
  // angle of 18 degrees out of nothing. Under-estimating the distance therefore
  // does not merely shrink the reconstruction, it bends it.
  const rawDepth: number[] = [];
  for (const f of frames) {
    const bounds: number[] = [];
    for (const [p, q] of BONES) {
      const L = expected[`${p}-${q}`];
      const a = f.pose2d[p];
      const b = f.pose2d[q];
      if (!L || !a || !b) continue;
      const lpx = dist2(a.p, b.p);
      if (lpx < 4) continue;
      bounds.push((cam.focalPx * L) / lpx);
    }
    rawDepth.push(bounds.length >= 6 ? (quantile(bounds, 0.15) as number) : NaN);
  }
  const fallback = opts.subjectDepthM ?? (median(rawDepth.filter(Number.isFinite)) as number) ?? 6;
  const filled = rawDepth.map((d) => (Number.isFinite(d) ? d : fallback));
  // The player's distance changes slowly; the estimator's frame-to-frame
  // scatter does not, so heavy smoothing is free.
  let rootDepthM = smooth(filled, 4);

  // Global scale refinement by maximum likelihood.
  //
  // A quantile heuristic ("the longest-looking bone must be the in-plane one")
  // is fragile: it is set by a single segment, and a few centimetres of error
  // in that segment's table entry moves the scale of the whole clip. Instead we
  // ask which distance makes the *whole set* of observed projections most
  // likely, under the only prior that is defensible when nothing is known about
  // the pose: bone directions are isotropic.
  //
  // That prior is not vague hand-waving. For an isotropic direction the
  // out-of-plane fraction u is uniform on [-1, 1], so the projected fraction
  // c = sqrt(1 - u^2) has density c / sqrt(1 - c^2), which is concentrated near
  // 1. In words: most bones, most of the time, project to nearly their full
  // length — which is exactly the fact a quantile rule tries to exploit, stated
  // as a likelihood over every observation rather than as a guess about one.
  const scaleFit = fitGlobalScale(frames, expected, rootDepthM, cam.focalPx);
  rootDepthM = rootDepthM.map((d) => d * scaleFit.correction);

  // A depth prior, where one exists, also supplies the root. It has to: the
  // prior speaks in absolute depths while the geometric solve only fixes each
  // bone *relative* to its parent, so leaving the root on the geometric
  // estimate blends two quantities measured from different origins and pulls
  // every limb toward an inconsistent frame. Anchoring the root on the prior
  // was the difference between the prior helping and the prior hurting.
  if (opts.depthPrior) {
    const priorRoot = frames.map((_, i) => opts.depthPrior?.depthM(i, "pelvis") ?? null);
    if (priorRoot.filter((d) => d !== null).length > frames.length * 0.5) {
      let last = priorRoot.find((d): d is number => d !== null) ?? rootDepthM[0];
      rootDepthM = priorRoot.map((d, i) => {
        if (d !== null) last = d;
        return d ?? last ?? rootDepthM[i];
      });
    }
  }

  // --- 2. Depth propagation --------------------------------------------
  const rays: Array<Partial<Record<Joint, Vec3>>> = [];
  const sigmaPx: Array<Partial<Record<Joint, number>>> = [];
  for (const f of frames) {
    const r: Partial<Record<Joint, Vec3>> = {};
    const s: Partial<Record<Joint, number>> = {};
    for (const j of JOINTS) {
      const kp = f.pose2d[j];
      if (!kp) continue;
      r[j] = backproject(cam, kp.p);
      s[j] = pixelSigmaFromScore(kp.score, shortSide);
    }
    rays.push(r);
    sigmaPx.push(s);
  }

  const solve = (preferNear: Record<LimbGroup, boolean>) =>
    propagateDepths({ frames, rays, sigmaPx, graph, rootDepthM, cam, opts, preferNear });

  // Under a near-orthographic view the depth of every bone is determined only
  // up to a sign. Flipping a whole limb's signs mirrors that limb while leaving
  // the image unchanged, so the ambiguity has to be resolved by evidence that
  // is itself handed — see `chiralityScore` — plus the requirement that the
  // result moves smoothly. Both are properties of the reconstruction, not of
  // the projection, which is exactly why they can break the tie.
  // A depth prior resolves the ambiguity outright, so the enumeration would
  // return 32 identical solutions. Skipping it is not just an optimisation: the
  // margin between hypotheses is the evidence behind `mirrorConfidence`, and a
  // margin of zero between identical candidates must not be read as "we could
  // not tell".
  if (opts.depthPrior) {
    const only = solve(Object.fromEntries(LIMB_GROUPS.map((g) => [g, true])) as Record<LimbGroup, boolean>);
    return finishLift(only, PRIOR_MIRROR_CONFIDENCE, frames, opts, cam, notes, rootDepthM);
  }

  // Coordinate descent over the hypothesis space rather than exhaustive
  // enumeration: start from the two all-near / all-far solutions, then flip one
  // limb group at a time and keep each flip that improves the score. The limb
  // groups are close to independent — flipping an arm does not change what the
  // legs look like — so a greedy pass finds the same optimum as the full 32-way
  // search at a fifth of the cost, and the search is not the interesting part
  // of the algorithm.
  const score = (out: PropagationOutput) =>
    chiralityScore(out.poses) - 0.35 * motionRoughness(out.poses, opts.dtScene, opts.anthro.heightM);

  const allNear = Object.fromEntries(LIMB_GROUPS.map((g) => [g, true])) as Record<LimbGroup, boolean>;
  const allFar = Object.fromEntries(LIMB_GROUPS.map((g) => [g, false])) as Record<LimbGroup, boolean>;
  let current = solve(allNear);
  let currentScore = score(current);
  const farOut = solve(allFar);
  const farScore = score(farOut);
  let mask = allNear;
  let runnerUp = farScore;
  if (farScore > currentScore) {
    runnerUp = currentScore;
    current = farOut;
    currentScore = farScore;
    mask = allFar;
  }

  for (const group of LIMB_GROUPS) {
    const candidateMask = { ...mask, [group]: !mask[group] };
    const candidate = solve(candidateMask);
    const candidateScore = score(candidate);
    if (candidateScore > currentScore) {
      runnerUp = currentScore;
      current = candidate;
      currentScore = candidateScore;
      mask = candidateMask;
    } else {
      runnerUp = Math.max(runnerUp, candidateScore);
    }
  }

  const pick = current;
  const bestChirality = chiralityScore(current.poses);
  const chiralMargin = Math.max(0, currentScore - runnerUp);
  // A confident choice needs a positive chirality *and* a clear margin over the
  // next best arrangement.
  const mirrorConfidence = clamp(
    bestChirality <= 0 ? 0.1 : 0.35 + 0.65 * clamp(chiralMargin / 0.25, 0, 1),
    0.1,
    0.95,
  );

  return finishLift(pick, mirrorConfidence, frames, opts, cam, notes, rootDepthM);
}

/**
 * Turns a chosen depth solution into the layer's result: court frame, quality
 * summary and diagnostics. Split out because the solution can arrive by two
 * routes — the hypothesis enumeration, or a learned prior that settles the
 * ambiguity on its own.
 */
function finishLift(
  pick: PropagationOutput,
  mirrorConfidence: number,
  frames: FrameObservation[],
  opts: LiftOptions,
  cam: PinholeCamera,
  notes: string[],
  rootDepthM: number[],
): Lift3DResult {
  const poses = pick.poses;
  const boneResidualM = pick.boneResidualCount ? pick.boneResidualSum / pick.boneResidualCount : 0;
  const impossibleFraction = pick.solves ? pick.impossible / pick.solves : 1;
  const ambiguousFraction = pick.solves ? pick.ambiguous / pick.solves : 1;

  // --- 3. Court frame ---------------------------------------------------
  // Two independent routes to the vertical, in order of trustworthiness:
  // the free-fall arc of the tossed ball, then the geometry of the player's own
  // stance. Whichever is available, its confidence travels with it and gates
  // every metric expressed against the vertical.
  const body = estimateVertical(poses);
  // The prior handed to the gravity solve is the *trunk axis*, not the stance
  // estimate. Gravity constrains the vertical to a plane and no further, so
  // whatever tilt the prior carries inside that plane survives untouched. The
  // trunk during the ready position is half a metre of well-reconstructed
  // segment and is off by a few degrees; the stance estimate is built from
  // centimetre-scale foot vectors and is off by twenty, and feeding it in here
  // simply preserved that error while the confidence went up.
  const gravity = estimateVerticalFromToss(
    frames,
    cam,
    body.prior,
    opts.subjectDepthM,
    opts.dtScene,
  );
  const useGravity = gravity !== null && gravity.confidence > body.upConfidence;
  const up = useGravity ? (gravity as GravityVertical).up : body.up;
  const upConfidence = useGravity ? (gravity as GravityVertical).confidence : body.upConfidence;
  const verticalSource: "toss_gravity" | "stance_geometry" = useGravity ? "toss_gravity" : "stance_geometry";
  // When both routes are available their disagreement is a free, independent
  // check that neither is quietly wrong.
  const verticalAgreementDeg =
    gravity !== null ? (Math.acos(clamp(dot3(gravity.up, body.up), -1, 1)) * 180) / Math.PI : null;
  const { forward, forwardConfidence } = estimateTargetDirection(poses, up, opts.contactFrame);
  const right = unit3(cross3(forward, up));
  const trueForward = unit3(cross3(up, right));

  // Ground plane: the lowest foot over the clip, which is on the court by
  // definition at least once during a serve.
  let groundZ = Number.POSITIVE_INFINITY;
  for (const pose of poses) {
    for (const j of ["footL", "footR", "ankleL", "ankleR"] as Joint[]) {
      const kp = pose[j];
      if (!kp) continue;
      groundZ = Math.min(groundZ, dot3(kp.p, up));
    }
  }
  if (!Number.isFinite(groundZ)) groundZ = 0;

  const toCourt = (p: Vec3): Vec3 =>
    v3(dot3(p, right), dot3(p, trueForward), dot3(p, up) - groundZ);
  const rotOnly = (p: Vec3): Vec3 => v3(dot3(p, right), dot3(p, trueForward), dot3(p, up));

  const courtPoses: Pose3D[] = poses.map((pose) => {
    const out: Pose3D = {};
    for (const j of JOINTS) {
      const kp = pose[j];
      if (!kp) continue;
      out[j] = { ...kp, p: toCourt(kp.p) };
    }
    return out;
  });

  const cameraInCourt: PinholeCamera = {
    ...cam,
    position: toCourt(cam.position),
    right: rotOnly(cam.right),
    up: rotOnly(cam.up),
    forward: rotOnly(cam.forward),
  };

  // --- Quality ---------------------------------------------------------
  if (impossibleFraction > EXPECTED_IMPOSSIBLE_FRACTION * 1.5) {
    notes.push(
      `${(impossibleFraction * 100).toFixed(1)} % der Segmente sind im Bild länger als anatomisch möglich — ` +
        "Hinweis auf Skalierungs- oder Trackingfehler.",
    );
  }
  if (ambiguousFraction > 0.25) {
    notes.push(
      `${(ambiguousFraction * 100).toFixed(0)} % der Segmente liegen nahezu in der Bildebene; ` +
        "ihre Tiefenrichtung ist aus dieser Kamera grundsätzlich mehrdeutig.",
    );
  }
  if (upConfidence < 0.6) {
    notes.push(
      verticalSource === "toss_gravity"
        ? "Die Vertikale stammt aus der Flugkurve des Balls, ist aber nur unsicher bestimmt."
        : "Die Vertikale wurde aus der Standgeometrie geschätzt (kein verwertbarer Ballwurf im Bild) " +
          "und ist entsprechend unsicher.",
    );
  }
  if (verticalAgreementDeg !== null && verticalAgreementDeg > 12) {
    notes.push(
      `Die beiden Schätzungen der Vertikalen — Ballflug und Standgeometrie — weichen um ` +
        `${verticalAgreementDeg.toFixed(0)}° voneinander ab. Alle Größen, die auf „oben" Bezug nehmen ` +
        "(Rumpfneigung, Treffpunkthöhe, Rotationen), sind entsprechend unsicher.",
    );
  }
  if (mirrorConfidence < 0.5) {
    notes.push(
      "Die Tiefenrichtung der Rekonstruktion ist mehrdeutig (Spiegelung um die Bildebene). " +
        "Rotationsrichtungen und Vorzeichen von Trennungswinkeln sind daher nicht belastbar.",
    );
  }
  if (forwardConfidence < 0.5) {
    notes.push("Die Zielrichtung ist unsicher; richtungsabhängige Größen werden entsprechend gekennzeichnet.");
  }

  const quality = clamp(
    (1 - clamp(boneResidualM / (0.08 * opts.anthro.heightM), 0, 1)) *
      (1 - clamp((impossibleFraction - EXPECTED_IMPOSSIBLE_FRACTION) * 3, 0, 0.8)) *
      (0.5 + 0.5 * upConfidence) *
      (0.55 + 0.45 * mirrorConfidence),
    0,
    1,
  );

  return {
    report: {
      id: "L6",
      name: "3D-Rekonstruktion",
      status: quality > 0.7 ? "ok" : quality > 0.35 ? "degraded" : "failed",
      quality,
      notes,
      diagnostics: {
        knochenResiduumCm: Number((boneResidualM * 100).toFixed(2)),
        unmoeglicheSegmenteProzent: Number((impossibleFraction * 100).toFixed(2)),
        mehrdeutigeSegmenteProzent: Number((ambiguousFraction * 100).toFixed(1)),
        tiefenprior: opts.depthPrior?.id ?? "keiner",
        vertikaleSicherheit: Number(upConfidence.toFixed(2)),
        vertikaleQuelle: verticalSource,
        vertikaleAbweichungGrad:
          verticalAgreementDeg === null ? null : Number(verticalAgreementDeg.toFixed(1)),
        schwerkraftMs2: gravity?.impliedGMs2 == null ? null : Number(gravity.impliedGMs2.toFixed(2)),
        spiegelungsSicherheit: Number(mirrorConfidence.toFixed(2)),
        zielrichtungSicherheit: Number(forwardConfidence.toFixed(2)),
        medianDistanzM: Number((median(rootDepthM) ?? 0).toFixed(2)),
      },
    },
    poses: courtPoses,
    cameraInCourt,
    rootDepthM,
    groundZ,
    verticalConfidence: upConfidence,
    mirrorConfidence,
    scaleRelSd: opts.subjectDepthRelSd,
    targetDirConfidence: forwardConfidence,
    boneResidualM,
    impossibleFraction,
  };
}

/* ------------------------------------------------------------------ */
/* Depth propagation                                                   */
/* ------------------------------------------------------------------ */

interface PropagationInput {
  frames: FrameObservation[];
  rays: Array<Partial<Record<Joint, Vec3>>>;
  sigmaPx: Array<Partial<Record<Joint, number>>>;
  graph: SkeletonGraph;
  rootDepthM: number[];
  cam: PinholeCamera;
  opts: LiftOptions;
  /**
   * Tie-break for the first frame, per limb group. The first frame's choice
   * propagates through the whole clip by temporal continuity, so it *is* the
   * hypothesis; enumerating it per limb rather than globally is what lets a
   * single arm be flipped without dragging the legs with it.
   */
  preferNear: Record<LimbGroup, boolean>;
}

interface PropagationOutput {
  poses: Pose3D[];
  boneResidualSum: number;
  boneResidualCount: number;
  impossible: number;
  solves: number;
  ambiguous: number;
}

/**
 * Solves the depth of every joint, for one global depth hypothesis.
 *
 * The solve is expressed per bone in terms of its out-of-plane fraction
 * u = sin(phi) — the component of the bone along the optical axis, divided by
 * its length. That parameterisation is what makes the temporal filter work:
 * u is a bounded, slowly varying property of the limb itself, whereas the
 * absolute depth along a ray is dominated by where the player happens to be
 * standing and drowns the signal we want to smooth.
 */
function propagateDepths(input: PropagationInput): PropagationOutput {
  const { frames, rays, sigmaPx, graph, rootDepthM, cam, opts, preferNear } = input;
  const n = frames.length;
  const sampleHz = 1 / opts.dtScene;

  const trees: TreeEdge[][] = [];
  for (let i = 0; i < n; i++) {
    trees.push(frameTree(graph, (j) => rays[i][j] !== undefined));
  }

  // --- Pass 1: per-bone out-of-plane fraction, with its posterior width ---
  const uSeries = new Map<string, Array<number | null>>();
  const uSd = new Map<string, Array<number | null>>();
  const provisional: Pose3D[] = [];
  let boneResidualSum = 0;
  let boneResidualCount = 0;
  let impossible = 0;
  let solves = 0;
  let ambiguous = 0;

  const edgeKey = (e: TreeEdge) => `${e.parent}|${e.child}`;
  const ensure = (key: string) => {
    if (!uSeries.has(key)) {
      uSeries.set(key, new Array(n).fill(null));
      uSd.set(key, new Array(n).fill(null));
    }
  };

  for (let i = 0; i < n; i++) {
    const r = rays[i];
    const s = sigmaPx[i];
    const tAlongRay: Partial<Record<Joint, number>> = {};
    if (r.pelvis) tAlongRay.pelvis = rootDepthM[i] / Math.max(1e-6, dot3(r.pelvis, cam.forward));

    for (const edge of trees[i]) {
      const rp = r[edge.parent];
      const rc = r[edge.child];
      const tp = tAlongRay[edge.parent];
      if (!rp || !rc || tp === undefined) continue;
      solves++;
      const key = edgeKey(edge);
      ensure(key);

      const c = clamp(dot3(rp, rc), -1, 1);
      const sin2 = Math.max(0, 1 - c * c);
      const L = edge.lengthM;
      const inPlaneM = tp * Math.sqrt(sin2);
      const disc = L * L - inPlaneM * inPlaneM;

      if (disc <= 0) {
        // The image says this bone is longer than it can be. The rate at which
        // that happens is the single most informative reconstruction-quality
        // number the system has, so it is counted rather than smoothed away.
        impossible++;
        boneResidualSum += inPlaneM - L;
        boneResidualCount++;
        tAlongRay[edge.child] = tp * c;
        uSeries.get(key)![i] = 0;
        uSd.get(key)![i] = 0.3;
        continue;
      }

      const mapDepth = Math.sqrt(disc);
      const posterior = posteriorOutOfPlane(L, inPlaneM, sigmaPFor(s, edge, tp, rp, cam));
      let magnitude = posterior.mean;
      let posteriorSd = posterior.sd;

      // Sign: the learned prior where one exists, temporal continuity on the
      // bone vector otherwise.
      const near = tp * c - magnitude;
      const far = tp * c + magnitude;
      const priorDepth = opts.depthPrior?.depthM(i, edge.child) ?? null;
      const along = dot3(rc, cam.forward);
      const tPrior = priorDepth !== null && along > 1e-6 ? priorDepth / along : null;
      const predicted = predictChild(provisional, i, edge, tp, rp);
      let tc: number;
      if (tPrior !== null) {
        // Inverse-variance blend of the geometric solve and the prior, carried
        // out on the dimensionless out-of-plane fraction so the two terms are
        // commensurable. Where the geometry is ambiguous the prior dominates;
        // where the bone is clearly foreshortened the geometry wins.
        const uGeo = clamp((tc = Math.abs(near - tPrior) <= Math.abs(far - tPrior) ? near : far) - tp * c, -L, L) / L;
        const uPrior = clamp((tPrior - tp * c) / L, -1.2, 1.2);
        const sigmaPriorU = Math.max(1e-3, opts.depthPrior!.sigmaM(i, edge.child) / Math.max(0.05, L));
        const sigmaGeoU = Math.max(1e-3, posterior.sd / Math.max(0.05, L));
        const wGeo = 1 / (sigmaGeoU * sigmaGeoU);
        const wPrior = 1 / (sigmaPriorU * sigmaPriorU);
        const uBlend = clamp((uGeo * wGeo + uPrior * wPrior) / (wGeo + wPrior), -1, 1);
        magnitude = Math.abs(uBlend) * L;
        posteriorSd = L / Math.sqrt(wGeo + wPrior);
        tc = tp * c + uBlend * L;
      } else if (predicted) {
        tc =
          norm3(sub3(scale3(rc, near), predicted)) <= norm3(sub3(scale3(rc, far), predicted)) ? near : far;
      } else {
        tc = preferNear[limbGroupOf(edge.child)] ? near : far;
      }
      const sign = tc >= tp * c ? 1 : -1;

      if (mapDepth < 0.15 * L) ambiguous++;
      boneResidualSum += Math.abs(Math.hypot(inPlaneM, mapDepth) - L);
      boneResidualCount++;

      tAlongRay[edge.child] = tc;
      uSeries.get(key)![i] = (sign * magnitude) / L;
      uSd.get(key)![i] = posteriorSd / L;
    }

    const running: Pose3D = {};
    for (const j of JOINTS) {
      const t = tAlongRay[j];
      const ray = r[j];
      if (t === undefined || !ray) continue;
      running[j] = { p: scale3(ray, t), sigmaInPlane: 0, sigmaDepth: 0, confidence: 1 };
    }
    provisional.push(running);
  }

  // --- Temporal filtering of the out-of-plane fractions -------------------
  // The in-plane position of every joint is measured directly and is already
  // clean; only the out-of-plane component is inferred, and its error is close
  // to independent between frames. Filtering it alone removes that noise
  // without touching the channel that carries the real information.
  const uFiltered = new Map<string, number[]>();
  for (const [key, series] of uSeries) {
    const known = series.filter((x): x is number => x !== null);
    if (known.length < 8) {
      uFiltered.set(key, series.map((x) => x ?? 0));
      continue;
    }
    let last = known[0];
    const dense = series.map((x) => {
      if (x !== null) last = x;
      return last;
    });
    uFiltered.set(key, butterworthLowPass(dense, DEPTH_CUTOFF_HZ, sampleHz));
  }

  // --- Pass 2: rebuild with the filtered depths --------------------------
  const rootFiltered = butterworthLowPass(rootDepthM, Math.min(4, sampleHz / 4), sampleHz);
  const poses: Pose3D[] = [];
  for (let i = 0; i < n; i++) {
    const r = rays[i];
    const s = sigmaPx[i];
    const tAlongRay: Partial<Record<Joint, number>> = {};
    const sigmaDepth: Partial<Record<Joint, number>> = {};
    if (r.pelvis) {
      tAlongRay.pelvis = rootFiltered[i] / Math.max(1e-6, dot3(r.pelvis, cam.forward));
      // The root's *shape* uncertainty, not its distance uncertainty.
      //
      // How far the player is from the camera is uncertain by several percent,
      // which at eight metres is more than half a metre. Writing that number
      // into the root joint's covariance makes every Monte-Carlo replica move
      // the pelvis half a metre in depth relative to the rest of the body,
      // which is not what the error does: it moves the *whole* skeleton
      // together, changing the scale and leaving the shape almost untouched.
      // Carried per joint it inflated every joint angle's uncertainty by a
      // factor of three to ten — enough to make a 240 fps calibrated capture
      // report that nothing could be distinguished from anything.
      //
      // The common-mode part is carried separately as `scaleRelSd` and applied
      // by the feature layer to absolute lengths only, which is the only place
      // it actually acts.
      sigmaDepth.pelvis =
        opts.depthPrior?.sigmaM(i, "pelvis") ?? ROOT_SHAPE_SIGMA_FRACTION * opts.anthro.heightM;
    }

    for (const edge of trees[i]) {
      const rp = r[edge.parent];
      const rc = r[edge.child];
      const tp = tAlongRay[edge.parent];
      if (!rp || !rc || tp === undefined) continue;
      const key = edgeKey(edge);
      const u = clamp(uFiltered.get(key)?.[i] ?? 0, -1, 1);
      const c = clamp(dot3(rp, rc), -1, 1);
      const chainedDepth = tp * c + u * edge.lengthM;

      // A redundant edge is a weaker constraint than a real bone: the distance
      // between two landmarks not joined by a rigid segment varies with posture.
      const penalty = edge.primary ? 1 : 1.8;
      const posteriorSd = (uSd.get(key)?.[i] ?? 0.3) * edge.lengthM;
      // The filter suppresses the independent part of the error; the systematic
      // part (bone-length prior, depth scale) survives it untouched.
      const filtered = posteriorSd * DEPTH_FILTER_GAIN;
      const anthropometric = 0.05 * edge.lengthM;
      const chained = Math.hypot(
        sigmaDepth[edge.parent] ?? 0,
        Math.hypot(filtered, anthropometric) * penalty,
      );
      // A depth prior measures this joint directly, so it *caps* the chain
      // rather than adding to it: an independent observation of the child's
      // depth ends the accumulation that started at the root. Without this the
      // uncertainty of a wrist would keep the pelvis's scale error even when a
      // model has just told us where the wrist is.
      const priorSigma = opts.depthPrior?.sigmaM(i, edge.child);
      const priorDepth = opts.depthPrior?.depthM(i, edge.child) ?? null;
      const along = dot3(rc, cam.forward);

      if (priorSigma !== undefined && priorSigma > 0 && priorDepth !== null && along > 1e-6) {
        // Inverse-variance combination of two *absolute* depths: the one
        // obtained by walking the kinematic chain from the root, and the one
        // the model states directly.
        //
        // Blending the chain's relative out-of-plane fraction instead — which
        // is what an earlier version did — leaves the chain free to drift: each
        // bone is placed relative to a parent that is already displaced, and by
        // the eighth link, from pelvis to hand, the hand is most of a metre out
        // even though the prior knew its depth to within five centimetres.
        // Anchoring on absolute depth at every joint ends the accumulation, and
        // it is the same estimator the uncertainty above already assumes.
        const tPrior = priorDepth / along;
        const sigmaPriorAlong = priorSigma / Math.max(0.2, along);
        const wChain = 1 / Math.max(chained * chained, 1e-8);
        const wPrior = 1 / (sigmaPriorAlong * sigmaPriorAlong);
        tAlongRay[edge.child] = (chainedDepth * wChain + tPrior * wPrior) / (wChain + wPrior);
        sigmaDepth[edge.child] = 1 / Math.sqrt(wChain + wPrior);
      } else {
        tAlongRay[edge.child] = chainedDepth;
        sigmaDepth[edge.child] = chained;
      }
    }

    const pose: Pose3D = {};
    for (const j of JOINTS) {
      const t = tAlongRay[j];
      const ray = r[j];
      if (t === undefined || !ray) continue;
      const z = t * dot3(ray, cam.forward);
      const kp = frames[i].pose2d[j];
      pose[j] = {
        p: scale3(ray, t),
        sigmaInPlane: ((s[j] ?? 6) * z) / cam.focalPx,
        // Beyond about half a metre a joint carries no usable depth information;
        // capping keeps the Monte-Carlo replicas from wandering into anatomical
        // nonsense while still marking the joint as effectively unobserved.
        sigmaDepth: Math.min(sigmaDepth[j] ?? 0.5, 0.6),
        confidence: clamp((kp?.score ?? 0) * (kp?.occluded ? 0.7 : 1), 0, 1),
      };
    }
    poses.push(pose);
  }

  return { poses, boneResidualSum, boneResidualCount, impossible, solves, ambiguous };
}

/**
 * Combined 1-sigma uncertainty of a bone's projected length, in metres.
 * Two endpoint localisation errors plus the depth-scale error, which acts
 * multiplicatively on everything measured at that depth.
 */
function sigmaPFor(
  sigmaPx: Partial<Record<Joint, number>>,
  edge: TreeEdge,
  tParent: number,
  parentRay: Vec3,
  cam: PinholeCamera,
): number {
  const zParent = tParent * dot3(parentRay, cam.forward);
  const perPx = zParent / cam.focalPx;
  // Only the endpoint localisation error belongs here. The depth-scale error is
  // common to every bone in the frame: it stretches the whole reconstruction
  // rather than randomising each segment's orientation, and folding it in per
  // bone would make each limb look individually unconstrained and let the solve
  // fabricate out-of-plane angles to absorb it. It is carried separately, as a
  // global scale uncertainty on absolute lengths.
  return Math.hypot((sigmaPx[edge.parent] ?? 6) * perPx, (sigmaPx[edge.child] ?? 6) * perPx);
}

/**
 * Limb groups for the depth-hypothesis search.
 *
 * Each group's depth signs are locked together by the kinematic chain but are
 * independent of the other groups', so the ambiguity is not one global binary
 * choice but one per limb. Enumerating all 32 combinations costs a few
 * milliseconds and removes the most damaging failure mode of a geometric
 * monocular lift: a single limb reconstructed inside-out while everything else
 * is correct.
 */
export type LimbGroup = "trunk" | "armL" | "armR" | "legL" | "legR";

export const LIMB_GROUPS: LimbGroup[] = ["trunk", "armL", "armR", "legL", "legR"];

export function limbGroupOf(joint: Joint): LimbGroup {
  if (joint.startsWith("elbow") || joint.startsWith("wrist") || joint.startsWith("hand")) {
    return joint.endsWith("L") ? "armL" : "armR";
  }
  if (joint.startsWith("knee") || joint.startsWith("ankle") || joint.startsWith("foot")) {
    return joint.endsWith("L") ? "legL" : "legR";
  }
  return "trunk";
}

/** Grid resolution for the isotropic projected-length prior. */
const PROJECTION_GRID = 40;

/**
 * Maximum-likelihood global scale correction.
 *
 * Returns the factor by which the provisional depth must be multiplied. The
 * search is over a generous range because a wrong assumed field of view can be
 * off by a third, and it is coarse-to-fine because the likelihood is smooth.
 */
export function fitGlobalScale(
  frames: FrameObservation[],
  expected: Record<string, number>,
  provisionalDepth: number[],
  focalPx: number,
): { correction: number; logLikelihood: number; samples: number } {
  interface Obs {
    ratio: number; // projected length / true length, at the provisional scale
    relSigma: number; // measurement noise on that ratio
  }
  const obs: Obs[] = [];
  const stride = Math.max(1, Math.floor(frames.length / 90));
  for (let i = 0; i < frames.length; i += stride) {
    const f = frames[i];
    for (const [p, q] of BONES) {
      const L = expected[`${p}-${q}`];
      const a = f.pose2d[p];
      const b = f.pose2d[q];
      if (!L || !a || !b) continue;
      const lpx = dist2(a.p, b.p);
      if (lpx < 8) continue;
      const metres = (lpx * provisionalDepth[i]) / focalPx;
      // Pixel noise translates into a relative length error that is worse for
      // short segments, which is why the hand and the foot get little weight.
      const sigmaPx = 2.5 * (1 - Math.min(a.score, b.score)) + 1.5;
      obs.push({ ratio: metres / L, relSigma: Math.max(0.02, sigmaPx / lpx) });
    }
  }
  if (obs.length < 30) return { correction: 1, logLikelihood: 0, samples: obs.length };

  // Isotropic prior on the projected fraction c = sqrt(1 - u^2).
  const grid: Array<{ c: number; w: number }> = [];
  for (let k = 0; k < PROJECTION_GRID; k++) {
    const u = (k + 0.5) / PROJECTION_GRID;
    const c = Math.sqrt(Math.max(0, 1 - u * u));
    grid.push({ c, w: 1 / PROJECTION_GRID });
  }

  const logL = (scale: number): number => {
    let total = 0;
    for (const o of obs) {
      const r = o.ratio * scale;
      const sigma = Math.max(o.relSigma * scale, 0.015);
      let acc = 0;
      for (const g of grid) {
        const z = (r - g.c) / sigma;
        acc += g.w * Math.exp(-0.5 * z * z);
      }
      total += Math.log(Math.max(acc, 1e-12));
    }
    return total;
  };

  let best = 1;
  let bestValue = Number.NEGATIVE_INFINITY;
  let lo = 0.6;
  let hi = 1.8;
  for (let pass = 0; pass < 3; pass++) {
    const steps = 24;
    for (let k = 0; k <= steps; k++) {
      const scale = lo + ((hi - lo) * k) / steps;
      const value = logL(scale);
      if (value > bestValue) {
        bestValue = value;
        best = scale;
      }
    }
    const span = (hi - lo) / steps;
    lo = best - span;
    hi = best + span;
  }
  return { correction: best, logLikelihood: bestValue, samples: obs.length };
}

/**
 * Which segment is taken to represent "lying in the image plane".
 *
 * Each bone contributes the 90th percentile of its own p/L over the clip; the
 * scale is then set from the 85th percentile across bones. Neither extreme is
 * safe: the very top is where mis-detections and table errors live, and the
 * median assumes every segment is foreshortened, which no full-body pose is.
 */
export const SCALE_QUANTILE = 0.85;

/**
 * Mirror confidence when a learned depth prior is supplying the depths. The
 * prior settles the sign directly; what is left is the possibility that the
 * prior itself is wrong, which is small but not zero.
 */
export const PRIOR_MIRROR_CONFIDENCE = 0.9;

/**
 * Fraction of segments that may exceed their anatomical length before it counts
 * against reconstruction quality.
 *
 * Some are expected: a segment lying in the image plane projects to its full
 * length, and noise pushes half of those measurements over it. Penalising from
 * zero would mark every well-framed clip as broken.
 */
export const EXPECTED_IMPOSSIBLE_FRACTION = 0.12;

/** Grid resolution for the posterior over a bone's out-of-plane angle. */
const POSTERIOR_GRID = 32;

/**
 * Posterior mean and standard deviation of a bone's out-of-plane component,
 * given its measured in-plane projection.
 *
 * Model: the bone has length L and makes an angle phi with the image plane, so
 * its projection is L*cos(phi) and its out-of-plane component is L*sin(phi).
 * The measured projection p is that value plus Gaussian noise. Under a prior
 * that is uniform in the *direction* of the bone — which is what "we know
 * nothing about which way it points" actually means in three dimensions — the
 * density of sin(phi) is uniform, and the posterior follows by Bayes.
 *
 * Integrating rather than maximising is the whole point: near the image plane
 * the likelihood is flat over a wide range of angles, the mode sits at the edge
 * of that range, and the mean sits in the middle of it where it belongs.
 */
export function posteriorOutOfPlane(L: number, p: number, sigmaP: number): { mean: number; sd: number } {
  const sigma = Math.max(sigmaP, 1e-4);
  let w0 = 0;
  let w1 = 0;
  let w2 = 0;
  for (let k = 0; k < POSTERIOR_GRID; k++) {
    const u = (k + 0.5) / POSTERIOR_GRID; // sin(phi), the out-of-plane fraction
    const predicted = L * Math.sqrt(Math.max(0, 1 - u * u));
    const r = (p - predicted) / sigma;
    const w = Math.exp(-0.5 * r * r);
    w0 += w;
    w1 += w * u;
    w2 += w * u * u;
  }
  if (w0 < 1e-12) return { mean: 0, sd: 0.35 * L };
  const meanU = w1 / w0;
  const varU = Math.max(0, w2 / w0 - meanU * meanU);
  return { mean: L * meanU, sd: L * Math.sqrt(varU) };
}

/**
 * Mean 3D acceleration of the skeleton, normalised by body height.
 *
 * A depth hypothesis that is wrong for part of the clip and right for the rest
 * shows up here and nowhere else: each frame on its own reprojects perfectly,
 * but the joint teleports across the ambiguity whenever the solve changes its
 * mind. Real limbs do not do that.
 */
function motionRoughness(poses: Pose3D[], dt: number, heightM: number): number {
  const accs: number[] = [];
  for (let i = 1; i < poses.length - 1; i++) {
    for (const j of JOINTS) {
      const a = poses[i - 1][j];
      const b = poses[i][j];
      const c = poses[i + 1][j];
      if (!a || !b || !c) continue;
      const ax = a.p.x - 2 * b.p.x + c.p.x;
      const ay = a.p.y - 2 * b.p.y + c.p.y;
      const az = a.p.z - 2 * b.p.z + c.p.z;
      accs.push(Math.hypot(ax, ay, az) / (dt * dt));
    }
  }
  if (accs.length === 0) return 1;
  // Normalise so the number is comparable across body sizes and frame rates:
  // 100 body-heights per second squared is already violent.
  return clamp(((mean(accs) as number) / heightM) / 100, 0, 4);
}

/**
 * Chirality test: does the reconstruction describe a real human or its mirror
 * image?
 *
 * Two body facts are handed, i.e. they change sign under reflection while
 * every projection stays identical:
 *
 *   - the toes point the way the chest faces, and
 *   - the knee bends forward relative to the hip-ankle line.
 *
 * With the joint *labels* fixed by the 2D detector (which knows a left ankle
 * from a right one by appearance), these two facts single out one of the two
 * depth hypotheses. Returning a signed, magnitude-bearing score rather than a
 * boolean lets the caller see how decisive the evidence actually was.
 */
function chiralityScore(poses: Pose3D[]): number {
  const scores: number[] = [];
  const upGuess = (pose: Pose3D): Vec3 | null => {
    const neck = pose.neck ?? pose.sternum;
    const pelvis = pose.pelvis;
    return neck && pelvis ? unit3(sub3(neck.p, pelvis.p)) : null;
  };
  const limit = Math.max(4, Math.floor(poses.length * 0.35));
  for (let i = 0; i < Math.min(limit, poses.length); i++) {
    const pose = poses[i];
    const up = upGuess(pose);
    const sl = pose.shoulderL;
    const sr = pose.shoulderR;
    if (!up || !sl || !sr) continue;
    const rightward = unit3(sub3(sr.p, sl.p));
    // For an upright human: facing = up x rightward.
    const facing = unit3(cross3(up, rightward));

    for (const side of ["L", "R"] as const) {
      const ankle = pose[`ankle${side}` as Joint];
      const foot = pose[`foot${side}` as Joint];
      if (ankle && foot) {
        const toe = unit3(sub3(foot.p, ankle.p));
        const horizontalToe = unit3(sub3(toe, scale3(up, dot3(toe, up))));
        scores.push(dot3(horizontalToe, facing));
      }
      const hip = pose[`hip${side}` as Joint];
      const knee = pose[`knee${side}` as Joint];
      const ankle2 = pose[`ankle${side}` as Joint];
      if (hip && knee && ankle2) {
        const axis = unit3(sub3(ankle2.p, hip.p));
        const offset = sub3(knee.p, hip.p);
        const lateral = sub3(offset, scale3(axis, dot3(offset, axis)));
        if (norm3(lateral) > 0.02) scores.push(dot3(unit3(lateral), facing));
      }
    }
  }
  return scores.length ? (mean(scores) as number) : 0;
}

/**
 * Predicts where a child joint should be, by extrapolating the bone vector from
 * the previous frames and attaching it to the current parent position.
 *
 * When a prior reconstruction is available (second pass), the prediction can
 * also look forward, which is what fixes the first frames of a clip: a greedy
 * forward-only pass has no history at frame 0 and any mistake it makes there
 * propagates through the whole sequence.
 */
function predictChild(
  reference: Pose3D[],
  i: number,
  edge: TreeEdge,
  tParent: number,
  parentRay: Vec3,
): Vec3 | null {
  const parentNow = scale3(parentRay, tParent);
  const boneAt = (k: number): Vec3 | null => {
    const pose = reference[k];
    if (!pose) return null;
    const pp = pose[edge.parent];
    const cc = pose[edge.child];
    if (!pp || !cc) return null;
    return sub3(cc.p, pp.p);
  };
  const b1 = boneAt(i - 1);
  const b2 = boneAt(i - 2);
  const bNext = boneAt(i + 1);
  let bone: Vec3 | null = null;
  if (b1 && b2) bone = add3(b1, sub3(b1, b2));
  else if (b1) bone = b1;
  else if (bNext) bone = bNext;
  else bone = boneAt(i);
  if (!bone) return null;
  return add3(parentNow, scale3(unit3(bone), edge.lengthM));
}

/**
 * Recovers the vertical from the player's own geometry.
 *
 * The cue is a set of directions that are all known to be horizontal whatever
 * the player is doing: the line between the two feet while both are on the
 * ground, the toe direction of each foot, and the hip and shoulder lines while
 * the player still stands upright. The vertical is the direction most nearly
 * orthogonal to all of them — the smallest principal direction of their scatter
 * matrix. How much smaller that eigenvalue is than the other two is a direct,
 * quantitative statement of how well the vertical is determined, which is what
 * the confidence reports.
 */

/**
 * Recovers the vertical from the acceleration of the tossed ball.
 *
 * A tossed ball is in free fall, so its acceleration *is* gravity — the one
 * quantity in a tennis video whose direction is known a priori and whose
 * magnitude can be checked. Under projection its image acceleration stays
 * parallel to the image of the gravity direction, which constrains the world
 * vertical to a plane through the camera centre. Intersecting that plane with
 * the player's trunk axis pins it down completely.
 *
 * This is worth far more than any cue taken from the body. Body-derived cues —
 * the line between the feet, the toe direction — are short segments whose
 * reconstructed depth is uncertain by a few centimetres, which tilts them by
 * tens of degrees. The toss arc spans most of a second and half a metre of
 * image, and its curvature is measured in the image plane where the data is
 * accurate.
 */
export interface GravityVertical {
  up: Vec3;
  confidence: number;
  /** Implied gravitational acceleration; a sanity check on the whole geometry. */
  impliedGMs2: number | null;
  sampleCount: number;
}

export function estimateVerticalFromToss(
  frames: FrameObservation[],
  cam: PinholeCamera,
  trunk: Vec3,
  subjectDepthM: number | null,
  dtScene: number,
): GravityVertical | null {
  // Ball samples before the strike. After contact the ball is no longer in the
  // toss arc, and the frames around contact are exactly where a detector is
  // least reliable, so we cut generously.
  const detections: Array<{ i: number; x: number; y: number; w: number }> = [];
  for (let i = 0; i < frames.length; i++) {
    const b = frames[i].ball;
    if (!b || b.score < 0.35) continue;
    detections.push({ i, x: b.p.x, y: b.p.y, w: b.score });
  }
  if (detections.length < 10) return null;

  // The strike shows up as a step change in image speed. Everything from there
  // on is a struck ball, not a tossed one.
  let cut = detections.length;
  let bestJump = 0;
  for (let k = 2; k < detections.length; k++) {
    const prev = Math.hypot(
      detections[k - 1].x - detections[k - 2].x,
      detections[k - 1].y - detections[k - 2].y,
    );
    const now = Math.hypot(detections[k].x - detections[k - 1].x, detections[k].y - detections[k - 1].y);
    const jump = now - prev;
    if (jump > bestJump && jump > 6) {
      bestJump = jump;
      cut = k;
    }
  }
  const toss = detections.slice(0, cut);
  if (toss.length < 8) return null;

  // Weighted quadratic fit of each image coordinate against time.
  const fit = (values: number[], times: number[], weights: number[]): { a2: number; residual: number } => {
    // Normal equations for y = c0 + c1 t + c2 t^2.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    let b0 = 0, b1 = 0, b2 = 0;
    for (let k = 0; k < values.length; k++) {
      const t = times[k];
      const w = weights[k];
      const t2 = t * t;
      s0 += w;
      s1 += w * t;
      s2 += w * t2;
      s3 += w * t2 * t;
      s4 += w * t2 * t2;
      b0 += w * values[k];
      b1 += w * values[k] * t;
      b2 += w * values[k] * t2;
    }
    const m = [
      [s0, s1, s2],
      [s1, s2, s3],
      [s2, s3, s4],
    ];
    const solved = solve3(m, [b0, b1, b2]);
    if (!solved) return { a2: 0, residual: Number.POSITIVE_INFINITY };
    const [c0, c1, c2] = solved;
    let residual = 0;
    let wsum = 0;
    for (let k = 0; k < values.length; k++) {
      const t = times[k];
      const predicted = c0 + c1 * t + c2 * t * t;
      residual += weights[k] * (values[k] - predicted) ** 2;
      wsum += weights[k];
    }
    return { a2: 2 * c2, residual: Math.sqrt(residual / Math.max(wsum, 1e-9)) };
  };

  const times = toss.map((d) => d.i * dtScene);
  const t0 = times[Math.floor(times.length / 2)];
  const centred = times.map((t) => t - t0);
  const weights = toss.map((d) => d.w);
  const fx = fit(toss.map((d) => d.x), centred, weights);
  const fy = fit(toss.map((d) => d.y), centred, weights);

  const ax = fx.a2;
  const ay = fy.a2;
  const accelMagnitude = Math.hypot(ax, ay);
  if (!Number.isFinite(accelMagnitude) || accelMagnitude < 1e-6) return null;

  // The plane of world directions whose image is parallel to (ax, ay).
  const mid = toss[Math.floor(toss.length / 2)];
  const X = (mid.x - cam.principal.x) / cam.focalPx;
  const Y = (cam.principal.y - mid.y) / cam.focalPx;
  const nCam = { u: ay, v: ax, w: -(ay * X + ax * Y) };
  const normal = unit3(
    v3(
      nCam.u * cam.right.x + nCam.v * cam.up.x + nCam.w * cam.forward.x,
      nCam.u * cam.right.y + nCam.v * cam.up.y + nCam.w * cam.forward.y,
      nCam.u * cam.right.z + nCam.v * cam.up.z + nCam.w * cam.forward.z,
    ),
  );

  // The vertical is the direction in that plane closest to the trunk axis.
  const projected = sub3(trunk, scale3(normal, dot3(trunk, normal)));
  if (norm3(projected) < 0.2) {
    // The trunk lies almost along the plane normal, so the projection is
    // ill-conditioned and this cue cannot finish the job on its own.
    return null;
  }
  let up = unit3(projected);
  if (dot3(up, trunk) < 0) up = scale3(up, -1);

  // Sanity check: how large is the implied gravity? The image only sees the
  // component of gravity parallel to the image plane, so the implied value is
  // g times that fraction, and it must not come out *larger* than g.
  let impliedGMs2: number | null = null;
  if (subjectDepthM && subjectDepthM > 0) {
    const inPlane = Math.sqrt(Math.max(0, 1 - dot3(up, cam.forward) ** 2));
    const measured = (accelMagnitude * subjectDepthM) / cam.focalPx;
    impliedGMs2 = inPlane > 0.05 ? measured / inPlane : null;
  }

  const residualPx = Math.hypot(fx.residual, fy.residual);
  // A clean parabola fit means the arc really is free fall. Scaling the
  // residual by the arc's own curvature makes the test independent of how
  // fast the clip was shot.
  const fitScore = clamp(1 - residualPx / Math.max(2, 0.12 * accelMagnitude * (centred[centred.length - 1] - centred[0]) ** 2), 0, 1);
  const spanScore = clamp(toss.length / 20, 0, 1);
  const conditioning = clamp(norm3(projected), 0, 1);
  let gravityScore = 1;
  if (impliedGMs2 !== null) {
    // Anything from roughly half to slightly above standard gravity is
    // consistent given the depth-scale uncertainty; far outside that, the thing
    // we tracked was probably not a ball in free fall.
    gravityScore = impliedGMs2 > 1.5 && impliedGMs2 < 13 ? 1 : 0.35;
  }
  const confidence = clamp(0.25 + 0.75 * fitScore * spanScore * conditioning * gravityScore, 0.15, 0.96);

  return { up, confidence, impliedGMs2, sampleCount: toss.length };
}

/** Solves a 3x3 linear system by Gaussian elimination with partial pivoting. */
function solve3(m: number[][], b: number[]): [number, number, number] | null {
  const a = m.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      for (let c = col; c < 4; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/**
 * Recovers the vertical from the player's own geometry, as a prior for the
 * gravity solve and as the fallback when no toss is visible.
 *
 * Two false starts are worth recording, because both looked reasonable and both
 * were wrong by roughly twenty degrees.
 *
 * The first took the set of vectors that are known to be horizontal — the line
 * between the feet, each foot's toe direction — and looked for the direction
 * orthogonal to all of them. A toe vector is about nine centimetres long, so
 * the two or three centimetres of depth error it inherits tilt it by twenty
 * degrees; normalising every cue to unit length gave those hopeless vectors the
 * same vote as the reliable ones.
 *
 * The second used the trunk axis, neck to pelvis. That looks like the obvious
 * choice and it is the worst one available: *every* joint along it is derived
 * rather than observed, the pelvis and the neck are both built from the same
 * shoulder and hip midpoints, and their depth errors are correlated in exactly
 * the way that tilts the segment rather than lengthening it.
 *
 * What works is the longest directly-observed axis in the body: cervicale to
 * the midpoint of the ankles, about 1.6 m of it, anchored at both ends on
 * joints a detector actually sees. The same few centimetres of depth error tilt
 * that by two degrees instead of twenty.
 */
function estimateVertical(poses: Pose3D[]): { up: Vec3; upConfidence: number; prior: Vec3 } {
  const early = Math.max(4, Math.floor(poses.length * 0.3));
  const window = Math.min(early, poses.length);

  const averageDirection = (dirs: Vec3[]): Vec3 | null => {
    if (dirs.length === 0) return null;
    const m = v3(
      mean(dirs.map((x) => x.x)) ?? 0,
      mean(dirs.map((x) => x.y)) ?? 0,
      mean(dirs.map((x) => x.z)) ?? 0,
    );
    return norm3(m) < 1e-6 ? null : unit3(m);
  };

  const midAnkle = (pose: Pose3D): Vec3 | null => {
    const l = pose.ankleL;
    const r = pose.ankleR;
    if (l && r) return scale3(add3(l.p, r.p), 0.5);
    return (l ?? r)?.p ?? null;
  };

  const longDirs: Vec3[] = [];
  const trunkDirs: Vec3[] = [];
  for (let i = 0; i < window; i++) {
    const pose = poses[i];
    const top = pose.neck ?? pose.head ?? pose.sternum;
    const feet = midAnkle(pose);
    if (top && feet && norm3(sub3(top.p, feet)) > 0.5) longDirs.push(unit3(sub3(top.p, feet)));
    const pelvis = pose.pelvis;
    if (top && pelvis) trunkDirs.push(unit3(sub3(top.p, pelvis.p)));
  }

  const longAxis = averageDirection(longDirs);
  const trunk = averageDirection(trunkDirs) ?? v3(0, 0, 1);
  const prior = longAxis ?? trunk;

  if (!longAxis) return { up: trunk, upConfidence: 0.2, prior };

  // Scatter of the per-frame estimates: a stable axis over the ready position
  // is a well-observed one.
  const spreadDeg =
    longDirs.length > 2
      ? (mean(longDirs.map((d) => Math.acos(clamp(dot3(d, longAxis), -1, 1)))) ?? 0) * (180 / Math.PI)
      : 20;

  // Independent cross-check: the court plane through the grounded feet. It is
  // far too noisy to *be* the answer, but a gross disagreement with it means
  // something is wrong with one of them.
  const ground = groundPlaneNormal(poses, prior);
  const groundDisagreementDeg =
    ground === null ? null : (Math.acos(clamp(Math.abs(dot3(ground, longAxis)), -1, 1)) * 180) / Math.PI;

  let confidence = clamp(0.85 - spreadDeg / 25, 0.2, 0.85);
  if (groundDisagreementDeg !== null && groundDisagreementDeg > 25) confidence *= 0.7;

  return { up: longAxis, upConfidence: confidence, prior };
}

/**
 * Normal of a plane fitted through the foot joints while they are on the court.
 * Weighted by how well each point was reconstructed. Used only as a
 * cross-check: a serve stance is nearly collinear, so this fit is often
 * ill-conditioned, and treating it as the primary answer was one of the
 * mistakes documented above.
 */
function groundPlaneNormal(poses: Pose3D[], reference: Vec3): Vec3 | null {
  const footJoints: Joint[] = ["ankleL", "ankleR", "footL", "footR"];
  let lowest = Number.POSITIVE_INFINITY;
  for (const pose of poses) {
    for (const j of footJoints) {
      const kp = pose[j];
      if (kp) lowest = Math.min(lowest, dot3(kp.p, reference));
    }
  }
  if (!Number.isFinite(lowest)) return null;

  const contacts: Array<{ p: Vec3; w: number }> = [];
  for (const pose of poses) {
    for (const j of footJoints) {
      const kp = pose[j];
      if (!kp) continue;
      if (dot3(kp.p, reference) - lowest > GROUND_CONTACT_BAND_M) continue;
      const w = clamp(kp.confidence, 0, 1) / (1 + (kp.sigmaDepth / 0.05) ** 2);
      if (w > 1e-3) contacts.push({ p: kp.p, w });
    }
  }
  const totalWeight = contacts.reduce((s, c) => s + c.w, 0);
  if (contacts.length < 12 || totalWeight < 1e-6) return null;

  const centroid = v3(
    contacts.reduce((s, c) => s + c.p.x * c.w, 0) / totalWeight,
    contacts.reduce((s, c) => s + c.p.y * c.w, 0) / totalWeight,
    contacts.reduce((s, c) => s + c.p.z * c.w, 0) / totalWeight,
  );
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const c of contacts) {
    const d = [c.p.x - centroid.x, c.p.y - centroid.y, c.p.z - centroid.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += c.w * d[i] * d[j];
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] /= totalWeight;
  const eig = symmetricEigen3(cov);
  // Ill-conditioned fits are worse than no fit at all.
  if (eig.values[0] < 1e-9 || eig.values[1] / eig.values[0] < 0.03) return null;
  const n = eig.vectors[2];
  return dot3(n, reference) < 0 ? scale3(n, -1) : n;
}

/**
 * Recovers "toward the target" as the horizontal normal of the shoulder line at
 * contact, pointing away from the player's back. Without a ball trajectory or
 * court lines this is a weak cue, and it is reported as such: the metrics that
 * need it are the ones about contact position relative to the body, and they
 * are gated on this confidence.
 */
function estimateTargetDirection(
  poses: Pose3D[],
  up: Vec3,
  contactFrame?: number,
): { forward: Vec3; forwardConfidence: number } {
  const idx = contactFrame ?? Math.floor(poses.length * 0.65);
  const candidates = [idx, idx - 1, idx + 1, Math.floor(poses.length / 2)];
  for (const i of candidates) {
    const pose = poses[i];
    if (!pose) continue;
    const sl = pose.shoulderL;
    const sr = pose.shoulderR;
    const pelvis = pose.pelvis;
    const head = pose.head ?? pose.neck;
    if (!sl || !sr || !pelvis || !head) continue;
    const shoulderAxis = unit3(sub3(sr.p, sl.p));
    const horizontalShoulder = unit3(sub3(shoulderAxis, scale3(up, dot3(shoulderAxis, up))));
    let normal = unit3(cross3(horizontalShoulder, up));
    // Disambiguate the sign with the nose/head offset from the trunk axis.
    const headOffset = sub3(head.p, pelvis.p);
    const horizontalHead = sub3(headOffset, scale3(up, dot3(headOffset, up)));
    if (dot3(normal, horizontalHead) < 0) normal = scale3(normal, -1);
    return { forward: normal, forwardConfidence: 0.45 };
  }
  return { forward: v3(0, 1, 0), forwardConfidence: 0 };
}
