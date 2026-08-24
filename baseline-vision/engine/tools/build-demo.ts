import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { analyse } from "../src/pipeline.ts";
import { buildScenario, GOOD_CAPTURE, PHONE_CAPTURE, type ScenarioOptions } from "../src/fixtures/scenarios.ts";
import { SERVE_PRESETS } from "../src/fixtures/serve-model.ts";
import { project } from "../src/core/camera.ts";
import { BONES, JOINTS, type Joint } from "../src/core/types.ts";
import type { HistoricalSample } from "../src/layers/l11-reference.ts";

/**
 * Builds the coach dashboard from real pipeline output.
 *
 * Nothing here is mocked. Each panel in the dashboard is rendered from the same
 * `AnalysisReport` the engine hands a caller, and the overlay is drawn from the
 * actual 2D detections and the reprojected 3D reconstruction. That constraint
 * is the point: a dashboard fed by hand-written sample data will happily
 * display things the engine cannot produce, and the gap between the mock-up and
 * the product is where over-claiming creeps back in.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dashboardDir = join(here, "..", "..", "dashboard");
const NOW = "2026-08-24T10:15:00Z";

interface DemoCase {
  id: string;
  title: string;
  subtitle: string;
  options: ScenarioOptions;
  history?: HistoricalSample[];
}

/**
 * The demo cases are the acceptance tests, made visible. A coach opening the
 * dashboard should be able to see for themselves what the system does with a
 * world-class serve, with a developing junior, and with footage it cannot use.
 */
const CASES: DemoCase[] = [
  {
    id: "weltklasse",
    title: "Weltklasse-Aufschlag",
    subtitle: "240 fps, erhöhte Seitenkamera, Brennweite bekannt, lernbasierter Tiefenprior",
    options: {
      preset: "elite",
      level: "elite",
      rig: "elevatedSide",
      fps: 240,
      knownFieldOfView: true,
      learnedDepth: true,
      render: GOOD_CAPTURE,
      playerId: "profi",
    },
  },
  {
    id: "nachwuchs",
    title: "Nachwuchsspieler U14",
    subtitle: "240 fps, erhöhte Seitenkamera, Brennweite bekannt, lernbasierter Tiefenprior",
    options: {
      preset: "developing",
      level: "junior_development",
      rig: "elevatedSide",
      fps: 240,
      ageYears: 13,
      knownFieldOfView: true,
      learnedDepth: true,
      render: GOOD_CAPTURE,
      playerId: "nachwuchs",
    },
    // Three earlier sessions of the same player, so the trend panel has
    // something real to work with.
    history: buildHistory(),
  },
  {
    id: "handyaufnahme",
    title: "Handyaufnahme vom Zaun",
    subtitle: "120 fps, diagonale Perspektive, Brennweite unbekannt, keine Tiefeninformation",
    options: {
      preset: "developing",
      level: "junior_development",
      rig: "diagonal",
      fps: 120,
      ageYears: 13,
      render: PHONE_CAPTURE,
      playerId: "nachwuchs",
    },
  },
  {
    id: "unbrauchbar",
    title: "Nicht auswertbare Aufnahme",
    subtitle: "30 fps, verwackelt, Spieler zeitweise verdeckt",
    options: {
      preset: "developing",
      level: "junior_development",
      rig: "side",
      fps: 30,
      ageYears: 13,
      render: {
        ...PHONE_CAPTURE,
        noisePx: 9,
        baseScore: 0.55,
        dropoutRate: 0.12,
        occlusionWindows: [
          { startS: 0.5, endS: 0.95, joints: ["hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR"] as Joint[] },
        ],
      },
      playerId: "nachwuchs",
    },
  },
];

/**
 * Earlier sessions for the junior, generated from the same model with a
 * shallower load, less separation and a later pelvis peak, so the trend the
 * dashboard shows is a real measurement of a real difference rather than a
 * decorative sparkline.
 */
function buildHistory(): HistoricalSample[] {
  const dates = ["2026-06-02", "2026-06-30", "2026-07-28"];
  const samples: HistoricalSample[] = [];

  dates.forEach((date, index) => {
    const developing = SERVE_PRESETS.developing;
    const scenario = buildScenario(`hist-${index}`, date, {
      preset: {
        ...developing,
        kneeFlexPeakDeg: developing.kneeFlexPeakDeg - 8 + index * 3,
        separationPeakDeg: developing.separationPeakDeg - 3 + index * 1.5,
        pelvisPeakLeadS: developing.pelvisPeakLeadS - 0.012 + index * 0.004,
      },
      level: "junior_development",
      rig: "elevatedSide",
      fps: 240,
      ageYears: 13,
      knownFieldOfView: true,
      learnedDepth: true,
      seed: 100 + index * 7,
      playerId: "nachwuchs",
    });
    const { report } = analyse(scenario.request, {
      now: `${date}T09:00:00Z`,
      depthPrior: scenario.depthPrior,
    });
    for (const metric of report.metrics) {
      // Only measurements the system itself would stand behind may enter a
      // player's history. A trend built from numbers the engine flagged as
      // unreliable is worse than no trend at all.
      if (metric.value === null || metric.rejected || metric.confidence < 0.5) continue;
      samples.push({
        sessionId: `session-${date}`,
        date,
        featureId: metric.id as HistoricalSample["featureId"],
        value: metric.value,
        sd: metric.sd ?? 0,
      });
    }
  });

  return samples;
}


/* ------------------------------------------------------------------ */
/* Overlay geometry                                                    */
/* ------------------------------------------------------------------ */

interface OverlayFrame {
  /** Detected 2D joints, image pixels; null where the detector saw nothing. */
  d: Array<[number, number] | null>;
  /** Reprojected 3D reconstruction, image pixels. */
  r: Array<[number, number] | null>;
  racket: [number, number, number, number] | null;
  ball: [number, number] | null;
  /** 3D joint positions in court metres, for the rotatable view. */
  p: Array<[number, number, number] | null>;
}

function buildOverlay(result: ReturnType<typeof analyse>, request: Parameters<typeof analyse>[0]): OverlayFrame[] {
  const cam = result.intermediates.cameraInCourt;
  const round = (n: number) => Math.round(n * 10) / 10;
  const round3 = (n: number) => Math.round(n * 1000) / 1000;

  return request.frames.map((frame, i) => {
    const pose3d = result.intermediates.poses3d[i] ?? {};
    const detected: Array<[number, number] | null> = [];
    const reprojected: Array<[number, number] | null> = [];
    const points: Array<[number, number, number] | null> = [];

    for (const joint of JOINTS) {
      const kp = frame.pose2d[joint];
      detected.push(kp ? [round(kp.p.x), round(kp.p.y)] : null);
      const kp3 = pose3d[joint];
      if (kp3) {
        const pr = project(cam, kp3.p);
        reprojected.push(Number.isFinite(pr.p.x) ? [round(pr.p.x), round(pr.p.y)] : null);
        points.push([round3(kp3.p.x), round3(kp3.p.y), round3(kp3.p.z)]);
      } else {
        reprojected.push(null);
        points.push(null);
      }
    }

    const head = result.intermediates.racketHeads[i];
    const grip = pose3d[request.player.hand === "right" ? "handR" : "handL"];
    let racket: [number, number, number, number] | null = null;
    if (head && grip) {
      const a = project(cam, grip.p);
      const b = project(cam, head);
      if (Number.isFinite(a.p.x) && Number.isFinite(b.p.x)) {
        racket = [round(a.p.x), round(a.p.y), round(b.p.x), round(b.p.y)];
      }
    }

    return {
      d: detected,
      r: reprojected,
      racket,
      ball: frame.ball ? [round(frame.ball.p.x), round(frame.ball.p.y)] : null,
      p: points,
    };
  });
}

/** Bounding box of everything the overlay draws, padded, clipped to the frame. */
function cropToAction(frames: OverlayFrame[], widthPx: number, heightPx: number): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const seen = (p: [number, number] | null) => {
    if (!p) return;
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  };
  for (const f of frames) {
    for (const p of f.d) seen(p);
    for (const p of f.r) seen(p);
    if (f.racket) { seen([f.racket[0], f.racket[1]]); seen([f.racket[2], f.racket[3]]); }
    seen(f.ball);
  }
  if (!Number.isFinite(minX)) return [0, 0, widthPx, heightPx];
  const padX = (maxX - minX) * 0.12 + 40;
  const padY = (maxY - minY) * 0.08 + 40;
  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);
  return [
    Math.round(x),
    Math.round(y),
    Math.round(Math.min(widthPx - x, maxX - minX + 2 * padX)),
    Math.round(Math.min(heightPx - y, maxY - minY + 2 * padY)),
  ];
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

const payload = {
  generatedAt: NOW,
  joints: JOINTS,
  bones: BONES.map(([a, b]) => [JOINTS.indexOf(a), JOINTS.indexOf(b)]),
  cases: CASES.map((demo) => {
    const scenario = buildScenario(demo.id, demo.title, demo.options);
    const result = analyse(scenario.request, {
      now: NOW,
      depthPrior: scenario.depthPrior,
      history: demo.history,
    });
    const overlay = buildOverlay(result, scenario.request);
    return {
      id: demo.id,
      title: demo.title,
      subtitle: demo.subtitle,
      report: result.report,
      overlay,
      // The player occupies a small part of a 1920x1080 frame. Cropping the
      // overlay to what actually moved keeps the skeleton readable instead of
      // reproducing the framing mistake the coach made.
      crop: cropToAction(overlay, result.report.video.widthPx, result.report.video.heightPx),
      truth: {
        kneeFlexionPeak: scenario.truth.params.kneeFlexPeakDeg,
        separationPeak: scenario.truth.params.separationPeakDeg,
        pelvisPeakLead: scenario.truth.params.pelvisPeakLeadS,
        trunkPeakLead: scenario.truth.params.trunkPeakLeadS,
        contactHeightRatio: scenario.truth.contactHeightFraction,
        contactFrame: scenario.truth.params.contactT * (scenario.request.video.fps ?? 240),
        peakRacketHeadSpeedKmh: scenario.truth.peakRacketHeadSpeedMs * 3.6,
      },
    };
  }),
};

// The dashboard ships as one self-contained file: the markup, the behaviour and
// the analysis are inlined together so it can be opened from a memory stick on
// a court-side laptop with no server and no network.
const template = readFileSync(join(dashboardDir, "template.html"), "utf8");
const appSource = readFileSync(join(dashboardDir, "app-source.js"), "utf8");
const html = template
  .replace("/*__DEMO_DATA__*/null", JSON.stringify(payload).replace(/</g, "\\u003c"))
  .replace("__APP_JS__", () => appSource.replace(/<\/script/gi, "<\\/script"));
writeFileSync(join(dashboardDir, "index.html"), html);

const bytes = Buffer.byteLength(html);
console.log(`dashboard/index.html written (${(bytes / 1024).toFixed(0)} KB)`);
for (const c of payload.cases) {
  const v = c.report.verdict;
  console.log(
    `  ${c.id.padEnd(14)} Qualität ${String(c.report.quality.overall).padStart(3)} · ` +
      `${v.kind === "assessment" ? `Score ${v.score}` : "keine Bewertung"} · ` +
      `${c.report.findings.length} Findings · ${c.report.notMeasurable.length} nicht messbar`,
  );
}
