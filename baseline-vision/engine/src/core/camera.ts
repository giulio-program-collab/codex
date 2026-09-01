import { type Vec2, type Vec3, cross3, dot3, rad, scale3, sub3, unit3, v3 } from "./math.ts";

/**
 * World frame convention, fixed once for the whole system:
 *
 *   x — along the baseline, positive to the server's right when facing the net
 *   y — toward the opposite baseline (court depth), positive away from the server
 *   z — up, z = 0 is the court surface
 *
 * All world quantities are metres, all image quantities are pixels, all angles
 * are degrees, all times are seconds. Layers that break this convention are the
 * classic source of silent factor-of-N errors, so it is enforced by naming:
 * anything in other units carries the unit in its identifier.
 */

export interface PinholeCamera {
  position: Vec3;
  /** Orthonormal camera basis in world coordinates. */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** Focal length in pixels (fx = fy; square pixels assumed). */
  focalPx: number;
  principal: Vec2;
  widthPx: number;
  heightPx: number;
}

export function lookAt(
  position: Vec3,
  target: Vec3,
  focalPx: number,
  widthPx: number,
  heightPx: number,
  worldUp: Vec3 = v3(0, 0, 1),
): PinholeCamera {
  const forward = unit3(sub3(target, position));
  const right = unit3(cross3(forward, worldUp));
  const up = unit3(cross3(right, forward));
  return {
    position,
    right,
    up,
    forward,
    focalPx,
    principal: { x: widthPx / 2, y: heightPx / 2 },
    widthPx,
    heightPx,
  };
}

/** Focal length in pixels from a horizontal field of view. */
export const focalFromHfov = (hfovDeg: number, widthPx: number): number =>
  widthPx / 2 / Math.tan(rad(hfovDeg) / 2);

export const hfovFromFocal = (focalPx: number, widthPx: number): number =>
  (2 * Math.atan(widthPx / 2 / focalPx) * 180) / Math.PI;

export interface Projection {
  p: Vec2;
  /** Distance along the camera forward axis, metres. Negative means behind the camera. */
  depthM: number;
  inFrame: boolean;
}

export function project(cam: PinholeCamera, world: Vec3): Projection {
  const d = sub3(world, cam.position);
  const z = dot3(d, cam.forward);
  if (z <= 1e-6) {
    return { p: { x: NaN, y: NaN }, depthM: z, inFrame: false };
  }
  const x = cam.principal.x + (cam.focalPx * dot3(d, cam.right)) / z;
  // Image y grows downward, world up grows upward.
  const y = cam.principal.y - (cam.focalPx * dot3(d, cam.up)) / z;
  const inFrame = x >= 0 && x < cam.widthPx && y >= 0 && y < cam.heightPx;
  return { p: { x, y }, depthM: z, inFrame };
}

/** Ray direction in world coordinates through an image point. */
export function backproject(cam: PinholeCamera, p: Vec2): Vec3 {
  const dx = (p.x - cam.principal.x) / cam.focalPx;
  const dy = -(p.y - cam.principal.y) / cam.focalPx;
  return unit3(
    v3(
      cam.forward.x + dx * cam.right.x + dy * cam.up.x,
      cam.forward.y + dx * cam.right.y + dy * cam.up.y,
      cam.forward.z + dx * cam.right.z + dy * cam.up.z,
    ),
  );
}

/** World point at a given depth along the ray through an image point. */
export function unproject(cam: PinholeCamera, p: Vec2, depthM: number): Vec3 {
  const dx = (p.x - cam.principal.x) / cam.focalPx;
  const dy = -(p.y - cam.principal.y) / cam.focalPx;
  const dir = v3(
    cam.forward.x + dx * cam.right.x + dy * cam.up.x,
    cam.forward.y + dx * cam.right.y + dy * cam.up.y,
    cam.forward.z + dx * cam.right.z + dy * cam.up.z,
  );
  return {
    x: cam.position.x + dir.x * depthM,
    y: cam.position.y + dir.y * depthM,
    z: cam.position.z + dir.z * depthM,
  };
}

/**
 * Metres-per-pixel at a given depth. This is the number the old tool replaced
 * with a single `pxPerCm` constant obtained by clicking the player's head and
 * feet once. That constant is only valid at the depth where it was measured;
 * at the contact point of a serve the racket is roughly 1.5-2.5 m closer to or
 * further from the camera, which is a 5-15 % scale error at typical filming
 * distances — silently applied to every distance the tool reported.
 */
export const metresPerPixel = (cam: PinholeCamera, depthM: number): number => depthM / cam.focalPx;

/**
 * How well a 3D direction is observed by this camera.
 *
 * Returns 1 when the direction lies in the image plane (fully observable from a
 * single view) and 0 when it points straight along the optical axis (completely
 * foreshortened; its length and angle are unrecoverable without depth).
 */
export function inPlaneFraction(cam: PinholeCamera, direction: Vec3): number {
  const d = unit3(direction);
  const alongAxis = Math.abs(dot3(d, cam.forward));
  return Math.sqrt(Math.max(0, 1 - alongAxis * alongAxis));
}

/**
 * Angle of the camera around the player, in degrees.
 * 0 = camera directly behind the player (looking down the court with them),
 * 90 = pure side-on, 180 = directly in front (facing the player).
 */
export function azimuthDeg(cam: PinholeCamera, playerFacing: Vec3): number {
  const toCam = unit3(sub3(cam.position, v3(0, 0, 0)));
  const f = unit3(v3(playerFacing.x, playerFacing.y, 0));
  const t = unit3(v3(toCam.x, toCam.y, 0));
  const c = dot3(f, t);
  return (Math.acos(Math.max(-1, Math.min(1, -c))) * 180) / Math.PI;
}

/** Camera-space offset used when perturbing a joint by its anisotropic sigma. */
export function cameraOffset(cam: PinholeCamera, du: number, dv: number, dw: number): Vec3 {
  const a = scale3(cam.right, du);
  const b = scale3(cam.up, dv);
  const c = scale3(cam.forward, dw);
  return v3(a.x + b.x + c.x, a.y + b.y + c.y, a.z + b.z + c.z);
}
