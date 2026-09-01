import {
  type Vec3,
  add3,
  clamp,
  cross3,
  deg,
  dot3,
  rad,
  scale3,
  sub3,
  unit3,
  v3,
} from "../core/math.ts";
import type { Handedness, Joint } from "../core/types.ts";
import { TRUNK_LANDMARK_FRACTION, type Anthropometry, anthropometryFor } from "./anthropometry.ts";

/**
 * A parametric, physically consistent 3D serve.
 *
 * This exists so that the pipeline can be validated against known truth without
 * a motion-capture lab. Every skeleton it produces has correct, constant bone
 * lengths; every degree of freedom is an explicit, named parameter; and the
 * timing parameters are exactly the quantities the biomechanics layer claims to
 * recover. If the pipeline reports a pelvis-to-contact lag of -75 ms on a clip
 * generated with `pelvisPeakLeadS: -0.075`, that is a real measurement of the
 * pipeline's accuracy. If it does not, the pipeline is wrong — and we find out
 * in CI rather than from a coach looking at a Sinner clip.
 *
 * Reference values in the presets come from the published literature the old
 * tool already cited (Frontiers in Sports and Active Living 2024 meta-analysis;
 * Landlinger et al. 2010), so the synthetic elite serve sits where the elite
 * distribution says it should.
 */

export interface ServeParams {
  heightCm: number;
  hand: Handedness;

  /** Contact time in seconds from clip start. */
  contactT: number;
  /** Total clip length in seconds. */
  durationS: number;

  /** Peak knee flexion at the trophy position, degrees (0 = straight leg). */
  kneeFlexPeakDeg: number;
  /** Time of peak knee flexion, relative to contact. */
  kneeFlexPeakLeadS: number;

  /** Trunk inclination away from the target at the trophy position, degrees. */
  trunkTiltDeg: number;
  /** Peak hip-shoulder separation before the drive, degrees. */
  separationPeakDeg: number;

  /**
   * Pelvis yaw at the start and at contact, in degrees, measured as the
   * heading of the hip line (left hip to right hip) from the +x axis.
   *
   * Convention, chosen so the model describes a real right-handed serve:
   * the net is at +y, the baseline runs along x. At the trophy position the
   * player is side-on with the *left* shoulder toward the net, so the hip line
   * points away from it and the yaw is strongly negative; by contact the hips
   * have rotated to roughly parallel with the baseline and slightly open.
   */
  pelvisYawStartDeg: number;
  pelvisYawEndDeg: number;
  /** Time of peak pelvis angular velocity, relative to contact (negative = before). */
  pelvisPeakLeadS: number;
  /** Time of peak thorax angular velocity, relative to contact. */
  trunkPeakLeadS: number;
  /** Rotation sharpness; smaller = more explosive. Seconds. */
  rotationTauS: number;

  /** Elbow flexion at contact, degrees (0 = fully extended arm). */
  elbowFlexAtContactDeg: number;
  /** Elbow flexion at the deepest point of the racket drop, degrees. */
  elbowFlexAtDropDeg: number;
  /** Shoulder elevation at contact, degrees (180 = arm straight above the trunk axis). */
  shoulderElevAtContactDeg: number;

  /** Peak jump height (ankle clearance) around contact, metres. */
  jumpHeightM: number;

}

/**
 * Presets. `elite` reproduces the published elite means; `highPerformance`
 * reproduces the published sub-elite means from the same studies; `developing`
 * is a junior with the two defects a coach actually sees first — a shallow
 * load and a reversed proximal-distal sequence.
 */
export const SERVE_PRESETS: Record<string, ServeParams> = {
  elite: {
    heightCm: 191,
    hand: "right",
    contactT: 1.15,
    durationS: 1.8,
    kneeFlexPeakDeg: 66,
    kneeFlexPeakLeadS: -0.34,
    trunkTiltDeg: 25,
    separationPeakDeg: 34,
    pelvisYawStartDeg: -62,
    pelvisYawEndDeg: 8,
    pelvisPeakLeadS: -0.075,
    trunkPeakLeadS: -0.057,
    rotationTauS: 0.03,
    elbowFlexAtContactDeg: 14,
    elbowFlexAtDropDeg: 118,
    shoulderElevAtContactDeg: 162,
    jumpHeightM: 0.24,
  },
  highPerformance: {
    heightCm: 183,
    hand: "right",
    contactT: 1.15,
    durationS: 1.8,
    kneeFlexPeakDeg: 58,
    kneeFlexPeakLeadS: -0.34,
    trunkTiltDeg: 21,
    separationPeakDeg: 26,
    pelvisYawStartDeg: -58,
    pelvisYawEndDeg: 4,
    pelvisPeakLeadS: -0.093,
    trunkPeakLeadS: -0.075,
    rotationTauS: 0.038,
    elbowFlexAtContactDeg: 22,
    elbowFlexAtDropDeg: 110,
    shoulderElevAtContactDeg: 152,
    jumpHeightM: 0.16,
  },
  developing: {
    heightCm: 165,
    hand: "right",
    contactT: 1.15,
    durationS: 1.8,
    kneeFlexPeakDeg: 28,
    kneeFlexPeakLeadS: -0.3,
    trunkTiltDeg: 11,
    separationPeakDeg: 9,
    pelvisYawStartDeg: -42,
    pelvisYawEndDeg: 2,
    // Reversed sequence: the trunk peaks *before* the pelvis. This is the single
    // most consequential technical fault a serve can have, and a system that
    // cannot see it has no business scoring serves at all.
    pelvisPeakLeadS: -0.045,
    trunkPeakLeadS: -0.062,
    rotationTauS: 0.055,
    elbowFlexAtContactDeg: 42,
    elbowFlexAtDropDeg: 84,
    shoulderElevAtContactDeg: 133,
    jumpHeightM: 0.04,
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Standard gravity, m/s^2. */
export const G_MS2 = 9.81;

/**
 * Time from release to contact for the toss, in seconds.
 * A tour-level toss is in the air a little under a second; the value matters
 * because it sets the arc's curvature, which is what the vertical estimate
 * reads.
 */
export const TOSS_FLIGHT_S = 0.9;

/** Smootherstep on [0, 1]; C2-continuous, so derived velocities stay smooth. */
const smootherstep = (u: number): number => {
  const x = clamp(u, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * Ramp that reaches exactly 1 at `tEnd` relative to contact and holds after.
 * Used where the parameter names the value *at contact*: a sigmoid would only
 * approach it asymptotically, which would silently make every preset wrong.
 */
const rampTo = (rel: number, tStart: number, tEnd: number): number =>
  smootherstep((rel - tStart) / (tEnd - tStart));

/** Bell curve peaking at `tPeak` with width `w`. */
const bell = (t: number, tPeak: number, w: number): number => Math.exp(-((t - tPeak) ** 2) / (2 * w * w));

function rotateAround(vec: Vec3, axis: Vec3, angleDeg: number): Vec3 {
  const k = unit3(axis);
  const th = rad(angleDeg);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const term1 = scale3(vec, c);
  const term2 = scale3(cross3(k, vec), s);
  const term3 = scale3(k, dot3(k, vec) * (1 - c));
  return add3(add3(term1, term2), term3);
}

/** Spherical interpolation between two unit directions. */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const ua = unit3(a);
  const ub = unit3(b);
  const om = Math.acos(clamp(dot3(ua, ub), -1, 1));
  if (om < 1e-6) return ua;
  const s1 = Math.sin((1 - t) * om) / Math.sin(om);
  const s2 = Math.sin(t * om) / Math.sin(om);
  return unit3(add3(scale3(ua, s1), scale3(ub, s2)));
}

/**
 * Sigmoid normalised so that it equals exactly 1 at contact.
 *
 * A plain sigmoid only approaches its end value asymptotically, and a
 * smoothstep reaches it with zero slope - which would make the racket come to a
 * standstill at the instant of contact. Neither is acceptable when the preset
 * parameter is defined as "the value at contact" and the derivative at contact
 * is itself a validated output.
 */
const normSigmoid = (rel: number, tPeak: number, tau: number): number =>
  sigmoid((rel - tPeak) / tau) / sigmoid(-tPeak / tau);

/**
 * Two-link IK with an explicit bend direction.
 *
 * `bendDir` must already be perpendicular to (end - root). Callers construct it
 * by rotating a reference vector through the same rotations as the limb, which
 * keeps it perpendicular by construction and therefore continuous. Deriving the
 * bend plane from a fixed world hint instead - the obvious implementation -
 * flips the joint by 180 degrees whenever the limb passes through the hint
 * direction, and an arm passing through vertical is not an edge case in a
 * serve, it is the middle of every swing.
 */
function twoLinkJointDir(root: Vec3, end: Vec3, l1: number, l2: number, bendDir: Vec3): Vec3 {
  const d = sub3(end, root);
  const dist = clamp(Math.hypot(d.x, d.y, d.z), 1e-4, l1 + l2 - 1e-4);
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const dir = unit3(d);
  let perp = sub3(bendDir, scale3(dir, dot3(bendDir, dir)));
  if (Math.hypot(perp.x, perp.y, perp.z) < 1e-9) perp = unit3(cross3(dir, v3(0, 0, 1)));
  return add3(add3(root, scale3(dir, a)), scale3(unit3(perp), h));
}

/** Two-link IK using a world-space hint; only safe for the legs, whose bend
 *  plane never approaches the hint direction. */
function twoLinkJoint(root: Vec3, end: Vec3, l1: number, l2: number, bendHint: Vec3): Vec3 {
  return twoLinkJointDir(root, end, l1, l2, bendHint);
}

/** Pulls `end` toward `root` so that it lies within `maxLen`. */
function clampToReach(root: Vec3, end: Vec3, maxLen: number): Vec3 {
  const d = sub3(end, root);
  const len = Math.hypot(d.x, d.y, d.z);
  if (len <= maxLen * 0.999) return end;
  return add3(root, scale3(unit3(d), maxLen * 0.999));
}

/** Fixed points the ball's flight is anchored to; see `serveAt`. */
export interface ServeAnchors {
  contact: Vec3;
  release: Vec3;
}

export interface ServeFrameTruth {
  t: number;
  joints: Record<Joint, Vec3>;
  racketGrip: Vec3;
  racketHead: Vec3;
  ball: Vec3 | null;
  /** Where the tossing hand is at this instant; used once, to anchor the toss. */
  releaseCandidate: Vec3;
  /** Ground-truth degrees of freedom, for validating the feature layer. */
  dof: {
    pelvisYawDeg: number;
    thoraxYawDeg: number;
    separationDeg: number;
    kneeFlexDeg: number;
    elbowFlexDeg: number;
    shoulderElevDeg: number;
    trunkTiltDeg: number;
    pelvisHeightM: number;
  };
}

export interface ServeTruth {
  params: ServeParams;
  anthro: Anthropometry;
  frames: ServeFrameTruth[];
  contactT: number;
  /** Derived contact geometry, used as ground truth by the feature tests. */
  contactHeightM: number;
  contactHeightFraction: number;
  contactAheadOfFrontFootM: number;
  peakRacketHeadSpeedMs: number;
  /** Ground-truth phase boundaries in seconds. */
  phases: Array<{ id: string; startS: number; endS: number }>;
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

/**
 * Evaluates the serve at a single instant. Sampling is continuous in time, so
 * the same motion can be rendered at any frame rate — which is precisely what
 * the frame-rate acceptance test needs.
 */
export function serveAt(
  params: ServeParams,
  a: Anthropometry,
  t: number,
  /**
   * Where the ball is struck, as a fixed point in space.
   *
   * The toss has to aim at one point for the whole flight. Aiming it at
   * "wherever the racket head is right now" recomputes the arc at every sample
   * and the result is not a parabola at all — the ball's acceleration comes out
   * with the wrong magnitude and even the wrong sign. `generateServe` evaluates
   * the racket head once at contact and passes it in.
   */
  anchors?: ServeAnchors,
): ServeFrameTruth {
  const tc = params.contactT;
  const rel = t - tc;
  const mirror = params.hand === "right" ? 1 : -1;

  // --- Rotation: two sigmoids whose inflection points are the commanded peaks.
  const pelvisYaw =
    params.pelvisYawStartDeg +
    (params.pelvisYawEndDeg - params.pelvisYawStartDeg) *
      sigmoid((rel - params.pelvisPeakLeadS) / params.rotationTauS);

  // The thorax is driven independently so that a reversed sequence is
  // expressible; separation then falls out of the two curves rather than being
  // imposed, exactly as it does in a real serve.
  // The shoulders start *more* closed than the hips; separation is therefore
  // pelvisYaw - thoraxYaw and is positive throughout the loading phase.
  const thoraxStart = params.pelvisYawStartDeg - params.separationPeakDeg;
  const thoraxEnd = params.pelvisYawEndDeg - 4;
  const thoraxYaw =
    thoraxStart + (thoraxEnd - thoraxStart) * sigmoid((rel - params.trunkPeakLeadS) / params.rotationTauS);

  // --- Legs: knee flexion bell around the loading instant.
  const kneeFlex =
    params.kneeFlexPeakDeg * bell(rel, params.kneeFlexPeakLeadS, 0.16) +
    6 * bell(rel, 0.28, 0.12); // soft landing flexion after contact

  // --- Vertical -----------------------------------------------------
  // The pelvis height is *derived* from the commanded knee flexion and the
  // stance, not set independently.
  //
  // An earlier version computed it as a "squat drop" of
  // legLen * (1 - cos(flexion / 2)), which silently assumes the ankle is
  // directly beneath the hip. In a serve stance it is not: the feet are set
  // apart along the baseline and one is well in front of the other, so the leg
  // is already at an angle before any knee bend. The consequence was that a
  // preset asking for 28 degrees of knee flexion produced a leg that actually
  // bent by five, and every test that referenced the parameter was measuring
  // something the fixture had never generated.
  //
  // Solving the leg triangle instead makes the commanded angle the angle that
  // appears in the geometry, which is what a ground truth has to mean.
  const airborne = Math.max(0, params.jumpHeightM * bell(rel, 0.02, 0.16));

  // --- Trunk tilt: away from the target during loading, upright at contact.
  const trunkTilt = params.trunkTiltDeg * bell(rel, -0.3, 0.22) + 6 * bell(rel, 0, 0.18);

  // --- Stance ---------------------------------------------------------
  // Serve stance: the front foot (left, for a right-hander) is closer to the
  // net and angled toward it; the back foot sits behind, roughly parallel to
  // the baseline. Both point in the direction the chest faces at the trophy
  // position, which is what makes the reconstruction's chirality test work.
  const groundZ = airborne;
  const stanceHalf = a.hipWidthM * 0.9;
  const ankleFront0 = v3(0.10 * mirror, 0.14, groundZ + a.ankleHeightM);
  const ankleBack0 = v3(-0.10 * mirror, -0.34 - stanceHalf * 0.1, groundZ + a.ankleHeightM);

  // Pelvis height from the leg triangle: for a knee flexion of `kneeFlex` the
  // hip must sit exactly this far from the ankle.
  const thigh = a.thighM;
  const shank = a.shankM;
  const hipToAnkle = Math.sqrt(
    Math.max(1e-6, thigh * thigh + shank * shank + 2 * thigh * shank * Math.cos(rad(kneeFlex))),
  );
  const pelvisRight0 = unit3(v3(Math.cos(rad(pelvisYaw)), Math.sin(rad(pelvisYaw)), 0));
  const frontSide = params.hand === "right" ? -1 : 1; // left hip for a right-hander
  const hipFrontOffset = scale3(pelvisRight0, (frontSide * mirror * a.hipWidthM) / 2);
  const dxHip = hipFrontOffset.x - ankleFront0.x;
  const dyHip = hipFrontOffset.y - ankleFront0.y;
  const vertical = Math.sqrt(Math.max(0.04, hipToAnkle * hipToAnkle - dxHip * dxHip - dyHip * dyHip));
  const pelvisZ = ankleFront0.z + vertical;

  // --- Frames -----------------------------------------------------------
  // Pelvis frame: yaw about world z, hip line = "right" axis.
  const pelvisRight = pelvisRight0;
  const pelvisUp = v3(0, 0, 1);
  const pelvis = v3(0, 0, pelvisZ);

  const hipR = add3(pelvis, scale3(pelvisRight, (mirror * a.hipWidthM) / 2));
  const hipL = add3(pelvis, scale3(pelvisRight, (-mirror * a.hipWidthM) / 2));

  // Thorax frame: yawed independently and tilted away from the target.
  const thoraxRight0 = unit3(v3(Math.cos(rad(thoraxYaw)), Math.sin(rad(thoraxYaw)), 0));
  const tiltAxis = unit3(v3(-thoraxRight0.y, thoraxRight0.x, 0)); // "forward" of the thorax
  const trunkUp = rotateAround(pelvisUp, tiltAxis, mirror * trunkTilt);
  const thoraxRight = unit3(rotateAround(thoraxRight0, tiltAxis, mirror * trunkTilt));

  const trunkLen = a.shoulderHeightM - a.hipHeightM;
  const spine = add3(pelvis, scale3(trunkUp, trunkLen * TRUNK_LANDMARK_FRACTION.spine));
  const thorax = add3(pelvis, scale3(trunkUp, trunkLen * TRUNK_LANDMARK_FRACTION.thorax));
  const sternum = add3(pelvis, scale3(trunkUp, trunkLen * TRUNK_LANDMARK_FRACTION.sternum));
  const neck = add3(pelvis, scale3(trunkUp, a.neckHeightM - a.hipHeightM));
  const head = add3(neck, scale3(trunkUp, a.headAboveNeckM * 0.6));

  const shoulderR = add3(sternum, scale3(thoraxRight, (mirror * a.shoulderWidthM) / 2));
  const shoulderL = add3(sternum, scale3(thoraxRight, (-mirror * a.shoulderWidthM) / 2));

  // --- Hitting arm ------------------------------------------------------
  // The arm is driven by the direction of the whole shoulder-to-wrist line plus
  // an elbow flexion angle; the elbow itself is then solved by two-link IK.
  // Driving the endpoint rather than the joint chain keeps bone lengths exact
  // and makes the commanded contact geometry come out exactly as specified.
  const dropLead = -0.125;
  const elevTrophy = 92;
  const armElev =
    elevTrophy +
    (params.shoulderElevAtContactDeg - elevTrophy) * normSigmoid(rel, -0.018, 0.024) +
    10 * Math.max(0, rel) * 4;

  const elbowFlex =
    params.elbowFlexAtContactDeg +
    (params.elbowFlexAtDropDeg - params.elbowFlexAtContactDeg) * bell(rel, dropLead, 0.045) +
    34 * bell(rel, 0.22, 0.08); // follow-through re-flexion

  const hitSide = params.hand === "right" ? "R" : "L";
  const shoulder = hitSide === "R" ? shoulderR : shoulderL;

  // Swing plane: the hand starts behind the shoulder line and crosses forward
  // through contact.
  const planeDeg = 22 - 34 * normSigmoid(rel, -0.018, 0.030);
  const downTrunk = scale3(trunkUp, -1);
  const swingAxis = unit3(cross3(thoraxRight, trunkUp));
  let armDir = rotateAround(downTrunk, swingAxis, -mirror * armElev);
  armDir = unit3(rotateAround(armDir, trunkUp, mirror * planeDeg));

  // Law of cosines: distance shoulder-to-wrist for a given elbow flexion.
  const u = a.upperArmM;
  const fl = a.forearmM;
  const reach = Math.sqrt(Math.max(1e-6, u * u + fl * fl + 2 * u * fl * Math.cos(rad(elbowFlex))));
  const wrist = add3(shoulder, scale3(armDir, reach));
  // Elbow bend plane: a reference vector carried through the same rotations as
  // the arm, so it stays perpendicular to the arm at every instant. During the
  // racket drop this puts the elbow high while the hand hangs behind the back.
  const elbowRef = unit3(rotateAround(swingAxis, trunkUp, mirror * planeDeg));
  const bendDir = unit3(rotateAround(elbowRef, armDir, mirror * 104));
  const elbow = twoLinkJointDir(shoulder, wrist, u, fl, bendDir);
  const foreDir = unit3(sub3(wrist, elbow));
  const upperDir = unit3(sub3(elbow, shoulder));
  const hand = add3(wrist, scale3(foreDir, a.handM));

  // Racket: at contact it is essentially in line with the forearm; during the
  // drop it hangs down behind the back. Interpolating the direction rather than
  // a joint angle keeps the racket-head path smooth and its speed realistic.
  const thoraxForward = unit3(cross3(trunkUp, thoraxRight));
  const dropDir = unit3(
    add3(add3(scale3(trunkUp, -0.94), scale3(thoraxForward, -0.28)), scale3(thoraxRight, mirror * 0.18)),
  );
  const dropWeight = clamp(bell(rel, dropLead, 0.044), 0, 1);
  const racketDir = slerp(foreDir, dropDir, dropWeight);
  const racketGrip = hand;
  const racketHead = add3(racketGrip, scale3(racketDir, a.racketLengthM));

  // --- Non-hitting arm (toss arm), kept simple but plausible ------------
  const tossElev = 150 * clamp(sigmoid((rel + 0.6) / 0.12), 0, 1) - 60 * clamp(sigmoid((rel + 0.1) / 0.1), 0, 1);
  const offShoulder = hitSide === "R" ? shoulderL : shoulderR;
  const offDir = unit3(rotateAround(downTrunk, swingAxis, -mirror * Math.max(10, tossElev)));
  const offElbow = add3(offShoulder, scale3(offDir, a.upperArmM));
  const offWrist = add3(offElbow, scale3(offDir, a.forearmM));
  const offHand = add3(offWrist, scale3(offDir, a.handM));

  // --- Legs -------------------------------------------------------------
  let ankleR = params.hand === "right" ? ankleBack0 : ankleFront0;
  let ankleL = params.hand === "right" ? ankleFront0 : ankleBack0;
  // A leg cannot be longer than thigh + shank. When the pelvis rises out of
  // reach the foot leaves the ground, which is exactly what happens in the
  // airborne phase - so we lift the ankle rather than stretching the segment.
  ankleR = clampToReach(hipR, ankleR, thigh + shank);
  ankleL = clampToReach(hipL, ankleL, thigh + shank);
  // The knee bends toward the direction the chest faces at the trophy (+x for a
  // right-hander in this frame), never sideways.
  const kneeHintR = unit3(v3(mirror, 0.15, 0));
  const kneeR = twoLinkJoint(hipR, ankleR, thigh, shank, kneeHintR);
  const kneeL = twoLinkJoint(hipL, ankleL, thigh, shank, kneeHintR);
  const toeFront = unit3(v3(0.75 * mirror, 0.66, 0));
  const toeBack = unit3(v3(0.97 * mirror, 0.25, 0));
  const toeR = params.hand === "right" ? toeBack : toeFront;
  const toeL = params.hand === "right" ? toeFront : toeBack;
  const footR = add3(ankleR, add3(scale3(toeR, a.footLengthM * 0.6), v3(0, 0, -a.ankleHeightM * 0.6)));
  const footL = add3(ankleL, add3(scale3(toeL, a.footLengthM * 0.6), v3(0, 0, -a.ankleHeightM * 0.6)));

  const joints = {
    head,
    neck,
    sternum,
    thorax,
    spine,
    pelvis,
    shoulderL,
    shoulderR,
    elbowL: hitSide === "R" ? offElbow : elbow,
    elbowR: hitSide === "R" ? elbow : offElbow,
    wristL: hitSide === "R" ? offWrist : wrist,
    wristR: hitSide === "R" ? wrist : offWrist,
    handL: hitSide === "R" ? offHand : hand,
    handR: hitSide === "R" ? hand : offHand,
    hipL,
    hipR,
    kneeL,
    kneeR,
    ankleL,
    ankleR,
    footL,
    footR,
  } as Record<Joint, Vec3>;

  // --- Ball -------------------------------------------------------------
  // The toss is a genuine ballistic arc. That matters twice over: a coach can
  // see whether the toss is where it should be, and the reconstruction can read
  // the direction of gravity straight off the ball's acceleration — which is
  // the single most reliable vertical reference a tennis clip contains.
  const contactPoint = anchors?.contact ?? racketHead;
  const releaseCandidate = add3(offShoulder, v3(0.28 * mirror, 0.12, 0.35));
  let ball: Vec3 | null = null;
  const tossStart = tc - TOSS_FLIGHT_S;
  if (t >= tossStart && t <= tc) {
    const release = anchors?.release ?? releaseCandidate;
    const T = TOSS_FLIGHT_S;
    // Initial velocity that puts the ball at the contact point at time tc under
    // constant gravity.
    const v0 = v3(
      (contactPoint.x - release.x) / T,
      (contactPoint.y - release.y) / T,
      (contactPoint.z - release.z) / T + 0.5 * G_MS2 * T,
    );
    const dt = t - tossStart;
    ball = v3(
      release.x + v0.x * dt,
      release.y + v0.y * dt,
      release.z + v0.z * dt - 0.5 * G_MS2 * dt * dt,
    );
  } else if (t > tc) {
    const dtb = t - tc;
    ball = v3(
      contactPoint.x + 1.5 * dtb,
      contactPoint.y + 42 * dtb,
      contactPoint.z - 0.5 * G_MS2 * dtb * dtb - 2.5 * dtb,
    );
  }

  const separation = pelvisYaw - thoraxYaw;
  const trunkAxis = sub3(sternum, pelvis);
  const upperArmVec = sub3(elbow, shoulder);
  const shoulderElevMeasured =
    deg(
      Math.acos(
        clamp(dot3(unit3(trunkAxis), unit3(upperArmVec)), -1, 1),
      ),
    ) * 1;

  return {
    t,
    joints,
    racketGrip,
    racketHead,
    ball,
    releaseCandidate,
    dof: {
      pelvisYawDeg: pelvisYaw,
      thoraxYawDeg: thoraxYaw,
      separationDeg: separation,
      kneeFlexDeg: kneeFlex,
      elbowFlexDeg: elbowFlex,
      shoulderElevDeg: 180 - shoulderElevMeasured,
      trunkTiltDeg: trunkTilt,
      pelvisHeightM: pelvisZ,
    },
  };
}

/** Renders the serve at a given frame rate. */
export function generateServe(params: ServeParams, sampleFps: number): ServeTruth {
  const a = anthropometryFor(params.heightCm, params.hand);
  const n = Math.max(2, Math.round(params.durationS * sampleFps));
  const anchor: ServeAnchors = {
    contact: serveAt(params, a, params.contactT).racketHead,
    release: serveAt(params, a, params.contactT - TOSS_FLIGHT_S).releaseCandidate,
  };
  const frames: ServeFrameTruth[] = [];
  for (let i = 0; i < n; i++) {
    frames.push(serveAt(params, a, i / sampleFps, anchor));
  }
  const tc = params.contactT;
  const contactFrame = serveAt(params, a, tc, anchor);
  const frontAnkle = params.hand === "right" ? contactFrame.joints.ankleL : contactFrame.joints.ankleR;
  // Racket-head speed is evaluated on a dense resample so that it does not
  // depend on the frame rate the clip happens to be rendered at.
  let peakSpeed = 0;
  const dense = 1 / 600;
  for (let t = Math.max(0, tc - 0.35); t <= tc + 0.15; t += dense) {
    const p0 = serveAt(params, a, t, anchor).racketHead;
    const p1 = serveAt(params, a, t + dense, anchor).racketHead;
    peakSpeed = Math.max(peakSpeed, Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) / dense);
  }
  return {
    params,
    anthro: a,
    frames,
    contactHeightM: contactFrame.racketHead.z,
    contactHeightFraction: contactFrame.racketHead.z / a.heightM,
    contactAheadOfFrontFootM: contactFrame.racketHead.y - frontAnkle.y,
    peakRacketHeadSpeedMs: peakSpeed,
    contactT: tc,
    phases: [
      { id: "preparation", startS: 0, endS: tc - 0.78 },
      { id: "toss", startS: tc - 0.78, endS: tc - 0.5 },
      { id: "loading", startS: tc - 0.5, endS: tc - 0.24 },
      { id: "leg_drive", startS: tc - 0.24, endS: tc - 0.14 },
      { id: "racquet_drop", startS: tc - 0.14, endS: tc - 0.07 },
      { id: "acceleration", startS: tc - 0.07, endS: tc - 0.005 },
      { id: "contact", startS: tc - 0.005, endS: tc + 0.005 },
      { id: "follow_through", startS: tc + 0.005, endS: tc + 0.25 },
      { id: "landing", startS: tc + 0.25, endS: params.durationS },
    ],
  };
}
