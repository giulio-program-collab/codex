import { writeFileSync } from "node:fs";

import { buildScenario, GOOD_CAPTURE } from "../src/fixtures/scenarios.ts";
import { cameraFromRig, CAMERA_RIGS } from "../src/fixtures/render.ts";
import { SERVE_PRESETS } from "../src/fixtures/serve-model.ts";
import { serialiseClip } from "../src/io/clip.ts";
import { dot3, sub3 } from "../src/core/math.ts";
import { JOINTS, type Joint } from "../src/core/types.ts";

/**
 * Writes a fixture serve out as a clip file.
 *
 * Two uses. It is a worked example of the shape a real clip file has to have —
 * far easier to copy than to build from the specification — and it is the input
 * that proves the import path works: analysing the exported file must produce
 * the same report as analysing the fixture directly.
 *
 *   node --experimental-strip-types tools/export-clip.ts beispiel.json [--no-depth] [--no-racket]
 */

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) ?? "beispiel-clip.json";
const withDepth = !args.includes("--no-depth");
const withRacket = !args.includes("--no-racket");

const scenario = buildScenario("beispiel", "Beispielaufschlag", {
  preset: "elite",
  level: "elite",
  rig: "elevatedSide",
  fps: 240,
  knownFieldOfView: true,
  render: GOOD_CAPTURE,
});

// Root-relative depth, exactly as a monocular lifter would emit it: z along the
// camera axis, measured from the pelvis, with the accuracy such models report.
const camera = cameraFromRig(CAMERA_RIGS.elevatedSide);
const depth: Array<Partial<Record<Joint, number>>> | undefined = withDepth
  ? scenario.request.frames.map((frame) => {
      const truthIndex = Math.min(
        scenario.truth.frames.length - 1,
        Math.round(frame.t / (scenario.truth.frames[1].t - scenario.truth.frames[0].t)),
      );
      const truthFrame = scenario.truth.frames[truthIndex];
      const rootDepth = dot3(sub3(truthFrame.joints.pelvis, camera.position), camera.forward);
      const map: Partial<Record<Joint, number>> = {};
      for (const joint of JOINTS) {
        const p = truthFrame.joints[joint];
        if (!p) continue;
        map[joint] = dot3(sub3(p, camera.position), camera.forward) - rootDepth;
      }
      return map;
    })
  : undefined;

const contactFrame = Math.round(SERVE_PRESETS.elite.contactT * 240);
const clip = serialiseClip(scenario.request, {
  contactFrame,
  source: "Synthetisch erzeugt von tools/export-clip.ts — kein echtes Video.",
  depth,
});

if (!withRacket) {
  for (const frame of clip.frames) {
    delete frame.racket;
    delete frame.ball;
  }
}

// Pixel coordinates to a tenth of a pixel and depths to a millimetre: writing
// seventeen digits of a quantity known to one part in a thousand triples the
// file size and states an accuracy nobody has.
const rounded = JSON.stringify(clip, (_key, value) =>
  typeof value === "number" ? Number(value.toFixed(4)) : value,
);

writeFileSync(out, rounded);
console.log(
  `${out} geschrieben: ${clip.frames.length} Bilder, Treffpunkt bei ${contactFrame}, ` +
    `${withDepth ? "mit" : "ohne"} Tiefeninformation, ${withRacket ? "mit" : "ohne"} Schläger und Ball ` +
    `(${(rounded.length / 1024).toFixed(0)} kB).`,
);
