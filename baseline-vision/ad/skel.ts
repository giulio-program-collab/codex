import { writeFileSync } from "node:fs";
import { generateServe, SERVE_PRESETS } from "/home/user/codex/baseline-vision/engine/src/fixtures/serve-model.ts";
import { CAMERA_RIGS, cameraFromRig } from "/home/user/codex/baseline-vision/engine/src/fixtures/render.ts";
import { project } from "/home/user/codex/baseline-vision/engine/src/core/camera.ts";
import { dot3, sub3, v3 } from "/home/user/codex/baseline-vision/engine/src/core/math.ts";
import { JOINTS } from "/home/user/codex/baseline-vision/engine/src/core/types.ts";

/**
 * The fixture serve, prepared for drawing rather than for measuring.
 *
 * Beyond the projected joints the film needs three things the analysis never
 * asks for: how far each joint is from the camera, so limbs can be drawn in
 * the right order; where each joint's shadow falls, so the figure stands on
 * something; and the court lines, so it stands somewhere.
 */

const truth = generateServe(SERVE_PRESETS.elite, 120);
const rig = CAMERA_RIGS.elevatedSide;
const cam = cameraFromRig(rig);

const px = (p: { x: number; y: number; z: number }) => {
  const q = project(cam, p);
  return [Math.round(q.p.x * 10) / 10, Math.round(q.p.y * 10) / 10];
};
const depth = (p: { x: number; y: number; z: number }) =>
  Math.round(dot3(sub3(p, cam.position), cam.forward) * 100) / 100;

// Pixels per metre at the player's own distance: focal length divided by depth.
// Every limb width in the film is then a real width in metres.
const metrePx = (p: { x: number; y: number; z: number }) =>
  Math.round((cam.focalPx / depth(p)) * 100) / 100;

const frames = truth.frames.map((f) => ({
  mpx: metrePx(f.joints.pelvis),
  p: JOINTS.map((j) => px(f.joints[j])),
  d: JOINTS.map((j) => depth(f.joints[j])),
  // Shadow: the same joint dropped onto the court surface.
  s: JOINTS.map((j) => px({ ...f.joints[j], z: 0.02 })),
  grip: px(f.racketGrip),
  head: px(f.racketHead),
  ball: f.ball ? px(f.ball) : null,
  knee: Math.round(f.dof.kneeFlexDeg * 10) / 10,
}));

/** Court lines around the server, in the world frame, projected once. */
const line = (a: [number, number], b: [number, number]) => [
  px(v3(a[0], a[1], 0)),
  px(v3(b[0], b[1], 0)),
];
const court = [
  line([-6, 0], [6, 0]), // baseline
  line([-6, 6.4], [6, 6.4]), // service line
  line([0, 0], [0, 6.4]), // centre service line
  line([-4.115, -1.4], [-4.115, 11.885]), // singles sideline
  line([4.115, -1.4], [4.115, 11.885]),
  line([-5.485, -1.4], [-5.485, 11.885]), // doubles sideline
  line([5.485, -1.4], [5.485, 11.885]),
];

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const f of frames) {
  for (const p of [...f.p, f.grip, f.head]) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
}
const pad = 70;

writeFileSync(
  "/tmp/claude-0/-home-user-codex/2c700628-09ec-574a-b906-c1b604896490/scratchpad/ad/skeleton.json",
  JSON.stringify({
    frames,
    court,
    box: { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 },
    joints: JOINTS,
    fps: 120,
    contactT: SERVE_PRESETS.elite.contactT,
  }),
);
console.log(frames.length, "frames · court lines", court.length);
