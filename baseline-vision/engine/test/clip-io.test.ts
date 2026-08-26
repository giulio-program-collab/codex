import test from "node:test";
import assert from "node:assert/strict";

import { analyse } from "../src/pipeline.ts";
import { buildScenario, GOOD_CAPTURE } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS } from "../src/fixtures/serve-model.ts";
import { cameraFromRig, CAMERA_RIGS } from "../src/fixtures/render.ts";
import { dot3, sub3 } from "../src/core/math.ts";
import { JOINTS, type Joint } from "../src/core/types.ts";
import {
  KEYPOINT_LAYOUTS,
  MIN_KEYPOINT_SCORE,
  parseClip,
  serialiseClip,
  type ClipFile,
} from "../src/io/clip.ts";
import { metric } from "./helpers.ts";

/**
 * The way in for footage this repository did not generate.
 *
 * A file format that cannot reproduce what it read is not a format, so the
 * first test is a round trip: export a fixture clip, read it back, and require
 * the analysis to be identical rather than merely similar. The rest cover what
 * a real clip actually looks like — no racket, no ball, a hand-marked contact,
 * an estimator that reports every landmark whether it found it or not.
 */

const NOW = "2026-08-25T10:00:00Z";
const CONTACT = Math.round(SERVE_PRESETS.elite.contactT * 240);

function fixture() {
  return buildScenario("clip-io", "Clip-IO", {
    preset: "elite",
    level: "elite",
    rig: "elevatedSide",
    fps: 240,
    knownFieldOfView: true,
    render: GOOD_CAPTURE,
  });
}

/** Root-relative depth along the camera axis, as a monocular lifter emits it. */
function lifterDepth(scenario: ReturnType<typeof fixture>): Array<Partial<Record<Joint, number>>> {
  const camera = cameraFromRig(CAMERA_RIGS.elevatedSide);
  const dt = scenario.truth.frames[1].t - scenario.truth.frames[0].t;
  return scenario.request.frames.map((frame) => {
    const truthFrame =
      scenario.truth.frames[Math.min(scenario.truth.frames.length - 1, Math.round(frame.t / dt))];
    const root = dot3(sub3(truthFrame.joints.pelvis, camera.position), camera.forward);
    const map: Partial<Record<Joint, number>> = {};
    for (const joint of JOINTS) {
      map[joint] = dot3(sub3(truthFrame.joints[joint], camera.position), camera.forward) - root;
    }
    return map;
  });
}

test("a clip survives being written out and read back unchanged", () => {
  const scenario = fixture();
  const file = serialiseClip(scenario.request);
  const { request } = parseClip(JSON.parse(JSON.stringify(file)));

  assert.equal(request.frames.length, scenario.request.frames.length);
  assert.deepEqual(request.video.widthPx, scenario.request.video.widthPx);
  assert.equal(request.player.heightCm, scenario.request.player.heightCm);

  // Every observed joint, in every frame, to the last digit.
  for (let i = 0; i < request.frames.length; i++) {
    const before = scenario.request.frames[i].pose2d;
    const after = request.frames[i].pose2d;
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), `Bild ${i}`);
    for (const joint of Object.keys(before) as Joint[]) {
      assert.deepEqual(after[joint], before[joint], `Bild ${i}, ${joint}`);
    }
  }

  // And the analysis of the re-read clip is the analysis of the original.
  const direct = analyse(scenario.request, { now: NOW }).report;
  const viaFile = analyse(request, { now: NOW }).report;
  assert.deepEqual(viaFile.metrics, direct.metrics);
  assert.deepEqual(viaFile.verdict, direct.verdict);
});

test("a bare pose track with a marked contact still measures the loading phase", () => {
  // What a general-purpose pose estimator gives you: joints, no racket, no
  // ball, plus a depth track from a monocular lifter and one frame number a
  // person read off the video.
  const scenario = fixture();
  const file = serialiseClip(scenario.request, { contactFrame: CONTACT, depth: lifterDepth(scenario) });
  for (const frame of file.frames) {
    delete frame.racket;
    delete frame.ball;
  }

  const { request, depthPrior, warnings } = parseClip(file);
  assert.ok(depthPrior, "der Tiefenprior muss aus der Tiefenspur entstehen");
  assert.equal(request.hints?.contactFrame, CONTACT);
  assert.ok(!warnings.some((w) => w.includes("Treffpunkt")), warnings.join(" | "));

  const { report } = analyse(request, { now: NOW, depthPrior });

  assert.ok(report.contactFrame !== null, "der markierte Treffpunkt muss ankommen");
  assert.ok(
    Math.abs((report.contactFrame as number) - CONTACT) <= 3,
    `Treffpunkt ${report.contactFrame} weicht von der Markierung ${CONTACT} ab`,
  );

  const knee = metric(report, "kneeFlexionPeak");
  assert.ok(knee && knee.interval95, "die Knieflexion muss messbar bleiben");
  const [lo, hi] = knee!.interval95 as [number, number];
  const truth = SERVE_PRESETS.elite.kneeFlexPeakDeg;
  assert.ok(
    truth >= lo && truth <= hi,
    `wahre Knieflexion ${truth}° liegt außerhalb von [${lo.toFixed(1)}, ${hi.toFixed(1)}]`,
  );
});

test("a missing racket is reported as absent, not as a failure", () => {
  const scenario = fixture();
  const file = serialiseClip(scenario.request, { contactFrame: CONTACT, depth: lifterDepth(scenario) });
  for (const frame of file.frames) {
    delete frame.racket;
    delete frame.ball;
  }
  const { request, depthPrior } = parseClip(file);
  const { report } = analyse(request, { now: NOW, depthPrior });

  const racket = report.pipeline.find((l) => l.id === "L7");
  const ball = report.pipeline.find((l) => l.id === "L8");
  assert.equal(racket?.status, "skipped");
  assert.equal(ball?.status, "skipped");

  // A layer that was never given anything must not block the verdict, and must
  // not be counted as a zero in the analysis quality.
  assert.ok(
    !report.issues.some((i) => i.id === "layer_failed_L7" || i.id === "layer_failed_L8"),
    "eine übersprungene Ebene darf kein blockierender Befund sein",
  );
  const racketComponent = report.quality.components.find((c) => c.id === "racket");
  assert.equal(racketComponent?.applicable, false);
  assert.ok(
    report.quality.overall >= 70,
    `eine gute Aufnahme ohne Schlägertrack sollte nicht unter 70 fallen, war ${report.quality.overall}`,
  );
});

test("keypoints the estimator did not find are not observations", () => {
  // MediaPipe emits all 33 landmarks in every frame, marking the ones it did
  // not find with a visibility near zero. Read literally, an unfound wrist
  // arrives as a confident point at the image origin.
  const scenario = fixture();
  const file = serialiseClip(scenario.request);
  const wristIndex = KEYPOINT_LAYOUTS.native.indexOf("wristR");
  for (const frame of file.frames) {
    frame.keypoints[wristIndex] = [0, 0, 0.01];
  }

  const { request } = parseClip(file);
  for (const frame of request.frames) {
    assert.equal(frame.pose2d.wristR, undefined, "ein Punkt unter der Score-Schwelle ist keine Beobachtung");
  }

  // And the threshold is the only thing separating the two readings.
  const generous = parseClip(file, { minScore: 0 });
  assert.ok(generous.request.frames[0].pose2d.wristR, "unterhalb der Schwelle nur, weil die Schwelle es sagt");
  assert.ok(MIN_KEYPOINT_SCORE > 0.01);
});

test("a clip file that cannot be analysed says why", () => {
  const scenario = fixture();
  const good = serialiseClip(scenario.request);

  const wrongFormat = { ...good, format: "irgendwas" } as unknown as ClipFile;
  assert.throws(() => parseClip(wrongFormat), /Unbekanntes Format/);

  const wrongVersion = { ...good, version: 99 };
  assert.throws(() => parseClip(wrongVersion), /Clip-Version/);

  const noHeight = { ...good, player: { ...good.player, heightCm: 0 } };
  assert.throws(() => parseClip(noHeight), /heightCm/);

  const wrongLayout = { ...good, keypointLayout: "coco17" as const };
  assert.throws(() => parseClip(wrongLayout), /Keypoints/);

  // Missing information that is merely expensive, rather than fatal, is a
  // warning with a remedy — not an exception.
  const noDepth = JSON.parse(JSON.stringify(good)) as ClipFile;
  noDepth.video.hfovDeg = undefined;
  const { warnings } = parseClip(noDepth);
  assert.ok(warnings.some((w) => w.includes("Brennweite")));
  assert.ok(warnings.some((w) => w.includes("Tiefeninformation")));
});
