import { writeFileSync } from "node:fs";
import { generateServe, SERVE_PRESETS } from "/home/user/codex/baseline-vision/engine/src/fixtures/serve-model.ts";
import { CAMERA_RIGS, cameraFromRig } from "/home/user/codex/baseline-vision/engine/src/fixtures/render.ts";
import { project } from "/home/user/codex/baseline-vision/engine/src/core/camera.ts";
import { BONES, JOINTS } from "/home/user/codex/baseline-vision/engine/src/core/types.ts";

// The very serve the acceptance tests run on, seen from the elevated side
// camera: the advertisement's animation is the project's own fixture.
const truth = generateServe(SERVE_PRESETS.elite, 120);
const cam = cameraFromRig(CAMERA_RIGS.elevatedSide);

const frames = truth.frames.map((f) => {
  const pts = JOINTS.map((j) => {
    const p = project(cam, f.joints[j]);
    return [Math.round(p.p.x * 10) / 10, Math.round(p.p.y * 10) / 10];
  });
  const grip = project(cam, f.racketGrip).p;
  const head = project(cam, f.racketHead).p;
  const ball = f.ball ? project(cam, f.ball).p : null;
  return {
    p: pts,
    r: [Math.round(grip.x * 10) / 10, Math.round(grip.y * 10) / 10, Math.round(head.x * 10) / 10, Math.round(head.y * 10) / 10],
    b: ball ? [Math.round(ball.x * 10) / 10, Math.round(ball.y * 10) / 10] : null,
    knee: Math.round(f.dof.kneeFlexDeg * 10) / 10,
  };
});

// Crop to what the figure actually occupies, with room for the toss.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const f of frames) {
  for (const p of f.p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  minX = Math.min(minX, f.r[0], f.r[2]); maxX = Math.max(maxX, f.r[0], f.r[2]);
  minY = Math.min(minY, f.r[1], f.r[3]); maxY = Math.max(maxY, f.r[1], f.r[3]);
}
const pad = 60;
const box = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };

writeFileSync(
  "/tmp/claude-0/-home-user-codex/2c700628-09ec-574a-b906-c1b604896490/scratchpad/ad/skeleton.json",
  JSON.stringify({ frames, box, bones: BONES.map(([a, b]) => [JOINTS.indexOf(a), JOINTS.indexOf(b)]), fps: 120,
    contactT: SERVE_PRESETS.elite.contactT, kneeTrue: SERVE_PRESETS.elite.kneeFlexPeakDeg }),
);
console.log(frames.length, "frames, box", JSON.stringify(box).slice(0, 90));
