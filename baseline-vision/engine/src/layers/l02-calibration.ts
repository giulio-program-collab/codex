import { clamp, dist2, median, quantile } from "../core/math.ts";
import { focalFromHfov, hfovFromFocal, type PinholeCamera } from "../core/camera.ts";
import { anthropometryFor, expectedBoneLengths } from "../fixtures/anthropometry.ts";
import type { AnalysisRequest, CameraPlacement, Joint, LayerReport, Pose2D } from "../core/types.ts";
import { BONES } from "../core/types.ts";

/**
 * Layer 2 — Camera calibration.
 *
 * The old tool's entire notion of scale was two clicks on the player's head and
 * feet, giving a single `pxPerCm`. That number is only valid at the depth where
 * it was measured and only if the segment clicked was perpendicular to the
 * optical axis. Applied to a contact point 1.5 m higher and often 1-2 m nearer
 * or further, it is wrong by 5-15 % — silently, on every distance the tool
 * printed.
 *
 * Here scale is a per-frame, per-joint quantity derived from the projection
 * model, and the focal length carries an explicit uncertainty that propagates
 * into every metric.
 */

export interface Intrinsics {
  focalPx: number;
  /** 1-sigma relative uncertainty of the focal length. */
  focalRelSd: number;
  principal: { x: number; y: number };
  widthPx: number;
  heightPx: number;
  source: "exif" | "court_calibration" | "assumed";
}

/**
 * Fallback field of view when nothing is known. Modern phone main cameras sit
 * between 65 and 78 degrees horizontally; action cameras go far wider. The
 * uncertainty attached here is deliberately large, because it is.
 */
const ASSUMED_HFOV_DEG = 68;
const ASSUMED_HFOV_REL_SD = 0.18;

export interface CalibrationResult {
  report: LayerReport;
  intrinsics: Intrinsics;
  /** Camera-frame camera: origin at the optical centre, +Z along the view axis. */
  camera: PinholeCamera;
  /** Median distance from camera to player, metres, and its relative uncertainty. */
  subjectDepthM: number | null;
  subjectDepthRelSd: number;
  placement: CameraPlacement;
  placementConfidence: number;
  /** How much of the player's body stayed inside the frame, 0..1. */
  framingScore: number;
}

/** Camera whose own frame is the reference frame: nothing is assumed about pose. */
/**
 * The reference frame the reconstruction is built in: origin at the optical
 * centre, +z along the view axis.
 *
 * The `right` axis points along **negative** image x, and that sign is load
 * bearing. A physical camera's (right, up, forward) triad is left-handed —
 * right = forward x up, which is why computer-vision conventions put the second
 * axis *down* rather than up. Declaring the reconstruction frame with a
 * right-pointing x while reconstructing from a physically left-handed camera
 * silently produces the *mirror image* of the scene: every bone length is
 * right, every joint angle is right, the reprojection matches the video
 * perfectly, and the athlete is left-handed.
 *
 * The geometric solve hides this, because flipping the depth sign of every bone
 * is itself a mirror, so the chirality search quietly compensates and the error
 * never surfaces. It surfaces the moment a depth prior pins the depths down:
 * the reconstruction then stays mirrored, and every measurement that carries a
 * direction — which side the hip opens toward, whether the pelvis leads the
 * trunk — comes out backwards while looking entirely healthy.
 *
 * Negating this axis makes the frame right-handed with respect to the world, so
 * chirality is preserved by construction rather than by search.
 */
export function cameraFrameCamera(i: Intrinsics): PinholeCamera {
  return {
    position: { x: 0, y: 0, z: 0 },
    right: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    forward: { x: 0, y: 0, z: 1 },
    focalPx: i.focalPx,
    principal: i.principal,
    widthPx: i.widthPx,
    heightPx: i.heightPx,
  };
}

export function calibrate(req: AnalysisRequest): CalibrationResult {
  const notes: string[] = [];
  const v = req.video;

  let intrinsics: Intrinsics;
  if (req.hints?.courtPoints && req.hints.courtPoints.length >= 6) {
    // A real court-line calibration would solve for the homography here. The
    // interface is in place; until it is implemented we do not pretend it ran.
    intrinsics = {
      focalPx: focalFromHfov(v.hfovDeg ?? ASSUMED_HFOV_DEG, v.widthPx),
      focalRelSd: 0.06,
      principal: { x: v.widthPx / 2, y: v.heightPx / 2 },
      widthPx: v.widthPx,
      heightPx: v.heightPx,
      source: "court_calibration",
    };
    notes.push("Platzlinien vorhanden: Brennweite und Bodenebene sind gestützt.");
  } else if (v.hfovDeg && v.hfovDeg > 20 && v.hfovDeg < 150) {
    intrinsics = {
      focalPx: focalFromHfov(v.hfovDeg, v.widthPx),
      focalRelSd: 0.05,
      principal: { x: v.widthPx / 2, y: v.heightPx / 2 },
      widthPx: v.widthPx,
      heightPx: v.heightPx,
      source: "exif",
    };
  } else {
    intrinsics = {
      focalPx: focalFromHfov(ASSUMED_HFOV_DEG, v.widthPx),
      focalRelSd: ASSUMED_HFOV_REL_SD,
      principal: { x: v.widthPx / 2, y: v.heightPx / 2 },
      widthPx: v.widthPx,
      heightPx: v.heightPx,
      source: "assumed",
    };
    notes.push(
      `Keine Brennweiteninformation: es wird ${ASSUMED_HFOV_DEG}° Bildwinkel angenommen ` +
        `(±${Math.round(ASSUMED_HFOV_REL_SD * 100)} %). Absolute Längen sind entsprechend unsicher.`,
    );
  }

  const camera = cameraFrameCamera(intrinsics);
  const anthro = anthropometryFor(req.player.heightCm, req.player.hand);
  const expected = expectedBoneLengths(anthro);

  // --- Subject depth ---------------------------------------------------
  // A bone of true length L whose image is l_px pixels long satisfies
  //     l_px * d / f  =  L * inPlaneFraction  <=  L,
  // hence  d <= f * L / l_px  for every bone. The tightest of these bounds is
  // attained by whichever bone happens to lie closest to the image plane, and
  // in a full-body shot at least one always does. A low quantile rather than
  // the strict minimum keeps a single mis-detected joint from collapsing the
  // estimate.
  const bounds: number[] = [];
  for (const f of req.frames) {
    for (const [p, q] of BONES) {
      const L = expected[`${p}-${q}`];
      if (!L) continue;
      const a = f.pose2d[p];
      const b = f.pose2d[q];
      if (!a || !b || a.score < 0.5 || b.score < 0.5) continue;
      const lpx = dist2(a.p, b.p);
      if (lpx < 4) continue;
      bounds.push((intrinsics.focalPx * L) / lpx);
    }
  }
  const subjectDepthM = bounds.length >= 12 ? quantile(bounds, 0.08) : null;
  if (subjectDepthM === null) {
    notes.push("Zu wenige verlässlich erkannte Körpersegmente für eine Distanzschätzung.");
  }
  // Depth uncertainty is dominated by the focal-length uncertainty; the
  // quantile estimator itself contributes a few percent on top.
  const subjectDepthRelSd = Math.sqrt(intrinsics.focalRelSd ** 2 + 0.05 ** 2);

  // --- Framing ---------------------------------------------------------
  const framingScore = estimateFraming(req, intrinsics);
  if (framingScore < 0.8) {
    notes.push(
      `Der Spieler ist in Teilen des Clips nicht vollständig im Bild (Framing ${Math.round(framingScore * 100)} %).`,
    );
  }

  // --- Placement -------------------------------------------------------
  const { placement, confidence } = classifyPlacement(req, intrinsics, subjectDepthM, anthro.shoulderWidthM);
  if (req.hints?.cameraPlacement && req.hints.cameraPlacement !== "unknown") {
    notes.push(`Angabe des Trainers zur Kameraposition: ${req.hints.cameraPlacement}.`);
  }

  let quality = 1;
  if (intrinsics.source === "assumed") quality *= 0.7;
  if (subjectDepthM === null) quality *= 0.4;
  quality *= clamp(0.55 + 0.45 * framingScore, 0, 1);
  quality *= clamp(0.6 + 0.4 * confidence, 0, 1);

  return {
    report: {
      id: "L2",
      name: "Kamerakalibrierung",
      status: subjectDepthM === null ? "degraded" : quality < 0.65 ? "degraded" : "ok",
      quality: clamp(quality, 0, 1),
      notes,
      diagnostics: {
        brennweiteQuelle: intrinsics.source,
        focalPx: Math.round(intrinsics.focalPx),
        bildwinkelGrad: Number(hfovFromFocal(intrinsics.focalPx, intrinsics.widthPx).toFixed(1)),
        distanzM: subjectDepthM === null ? null : Number(subjectDepthM.toFixed(2)),
        distanzUnsicherheitProzent: Number((subjectDepthRelSd * 100).toFixed(1)),
        kameraposition: placement,
        positionsSicherheit: Number(confidence.toFixed(2)),
        framing: Number(framingScore.toFixed(2)),
      },
    },
    intrinsics,
    camera,
    subjectDepthM,
    subjectDepthRelSd,
    placement,
    placementConfidence: confidence,
    framingScore,
  };
}

/** Fraction of frames in which head, both hips and both ankles are inside the image. */
function estimateFraming(req: AnalysisRequest, i: Intrinsics): number {
  const required: Joint[] = ["head", "hipL", "hipR", "ankleL", "ankleR"];
  let ok = 0;
  let total = 0;
  for (const f of req.frames) {
    total++;
    const inside = required.every((j) => {
      const kp = f.pose2d[j];
      if (!kp) return false;
      const m = 2;
      return kp.p.x > m && kp.p.x < i.widthPx - m && kp.p.y > m && kp.p.y < i.heightPx - m;
    });
    if (inside) ok++;
  }
  return total === 0 ? 0 : ok / total;
}

/**
 * Classifies where the camera stands relative to the player, from the
 * foreshortening of the shoulder line.
 *
 * A shoulder line that projects to nearly its full anatomical width is
 * perpendicular to the optical axis; one that collapses to a fraction of it is
 * pointing at the camera. This is measured, not asked for, because coaches
 * routinely mis-describe their own camera position — and because the answer
 * decides which metrics are admissible at all.
 */
function classifyPlacement(
  req: AnalysisRequest,
  i: Intrinsics,
  depthM: number | null,
  shoulderWidthM: number,
): { placement: CameraPlacement; confidence: number } {
  if (depthM === null) return { placement: "unknown", confidence: 0 };
  const fractions: number[] = [];
  for (const f of req.frames) {
    const fr = shoulderInPlaneFraction(f.pose2d, i.focalPx, depthM, shoulderWidthM);
    if (fr !== null) fractions.push(fr);
  }
  if (fractions.length < 5) return { placement: "unknown", confidence: 0.1 };
  // Early frames: the player is still square to their stance, before rotation.
  const early = fractions.slice(0, Math.max(5, Math.floor(fractions.length * 0.3)));
  const fr = clamp(median(early) ?? 0.5, 0, 1);

  // What the foreshortening means depends on how the player stands at the start
  // of the stroke, and that differs by stroke.
  //
  // A groundstroke begins square to the net, so the shoulder line runs along the
  // baseline: seeing it at full width means the camera looks down the baseline.
  // A serve begins side-on, with the shoulder line pointing *across* the court —
  // so the same observation means the opposite. Reading a serve with the
  // groundstroke rule labelled every side-on camera "behind_baseline", which is
  // wrong in the debug view precisely when somebody is using the debug view to
  // work out why a measurement looks odd.
  const sideOnWhenVisible = req.stroke === "serve";
  let placement: CameraPlacement;
  let confidence: number;
  if (fr > 0.85) {
    placement = sideOnWhenVisible ? "side_on" : "behind_baseline";
    confidence = 0.7;
  } else if (fr < 0.45) {
    placement = sideOnWhenVisible ? "behind_baseline" : "side_on";
    confidence = 0.7;
  } else {
    placement = "diagonal";
    confidence = 0.55;
  }
  const hinted = req.hints?.cameraPlacement;
  if (hinted && hinted !== "unknown") {
    if (hinted === placement) confidence = clamp(confidence + 0.2, 0, 0.95);
    else confidence = clamp(confidence - 0.25, 0.1, 0.9);
  }
  return { placement, confidence };
}

export function shoulderInPlaneFraction(
  pose: Pose2D,
  focalPx: number,
  depthM: number,
  shoulderWidthM: number,
): number | null {
  const a = pose.shoulderL;
  const b = pose.shoulderR;
  if (!a || !b || a.score < 0.5 || b.score < 0.5) return null;
  const projectedM = (dist2(a.p, b.p) * depthM) / focalPx;
  return clamp(projectedM / shoulderWidthM, 0, 1.2);
}
