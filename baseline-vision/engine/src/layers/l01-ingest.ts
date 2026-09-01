import { clamp, mean, median } from "../core/math.ts";
import type { AnalysisRequest, LayerReport, StrokeType } from "../core/types.ts";

/**
 * Layer 1 — Video ingestion and the hard quality gate.
 *
 * Nothing downstream runs on a clip this layer rejects. The point is not to be
 * strict for its own sake: it is that every later layer produces a number no
 * matter what it is fed, and numbers that look like measurements are the most
 * expensive kind of wrong output a coaching tool can produce.
 */

export interface TimingAdmissibility {
  /** Effective temporal resolution of the scene, in Hz. */
  effectiveHz: number;
  /** One sample interval in milliseconds. */
  sampleMs: number;
  /**
   * Whether inter-segment timing differences may be reported at all.
   *
   * The elite/high-performance difference in pelvis-peak-to-contact timing is
   * about 18 ms (Landlinger et al. 2010). At 30 fps one frame is 33 ms, so a
   * single repetition cannot resolve the difference at all; the old tool's own
   * table put the hit rate at 61 %, barely above a coin flip. We keep that gate
   * and make it explicit rather than burying it in a footnote.
   */
  timingAllowed: boolean;
  /** Repetitions needed before a timing mean may be quoted at this rate. */
  repetitionsRequired: number;
  reason: string | null;
}

export const MIN_TIMING_HZ = 60;

export function timingAdmissibility(effectiveHz: number, repetitions: number): TimingAdmissibility {
  const sampleMs = 1000 / effectiveHz;
  const repetitionsRequired = effectiveHz >= 120 ? 3 : effectiveHz >= 60 ? 5 : Number.POSITIVE_INFINITY;
  if (effectiveHz < MIN_TIMING_HZ) {
    return {
      effectiveHz,
      sampleMs,
      timingAllowed: false,
      repetitionsRequired,
      reason:
        `Zeitliche Auflösung ${sampleMs.toFixed(1)} ms. Die zu unterscheidenden ` +
        `Sequenz-Unterschiede liegen bei rund 18 ms. Unter ${MIN_TIMING_HZ} Hz wird ` +
        `keine Timing-Aussage erzeugt.`,
    };
  }
  if (repetitions < repetitionsRequired) {
    return {
      effectiveHz,
      sampleMs,
      timingAllowed: false,
      repetitionsRequired,
      reason:
        `Bei ${effectiveHz} Hz trägt erst der Mittelwert aus ${repetitionsRequired} ` +
        `Wiederholungen eine Aussage; vorhanden sind ${repetitions}.`,
    };
  }
  return { effectiveHz, sampleMs, timingAllowed: true, repetitionsRequired, reason: null };
}

export interface IngestResult {
  report: LayerReport;
  /** Effective scene sampling rate in Hz (capture rate, not playback rate). */
  effectiveHz: number;
  /** Seconds of scene time per frame. */
  dtScene: number;
  /** Frames judged usable; downstream layers see only these. */
  usableFrameCount: number;
  fatal: boolean;
}

const MIN_RESOLUTION_PX = 480;
const MIN_FRAMES = 12;

export function ingest(req: AnalysisRequest): IngestResult {
  const notes: string[] = [];
  const v = req.video;
  const effectiveHz = v.captureFps > 0 ? v.captureFps : v.fps;
  // In a slow-motion clip, one stored frame advances the scene by 1/captureFps
  // seconds, not 1/fps. Getting this wrong scales every velocity by up to 8x —
  // and produces exactly the kind of confident, wrong number we are trying to
  // eliminate.
  const dtScene = 1 / effectiveHz;

  let quality = 1;
  let fatal = false;

  if (req.frames.length < MIN_FRAMES) {
    notes.push(`Nur ${req.frames.length} Bilder im Clip — zu wenig für eine Schlaganalyse.`);
    fatal = true;
    quality = 0;
  }

  const shortSide = Math.min(v.widthPx, v.heightPx);
  if (shortSide < MIN_RESOLUTION_PX) {
    notes.push(`Auflösung ${v.widthPx}×${v.heightPx} zu gering für belastbare Gelenklokalisierung.`);
    quality *= 0.35;
  } else if (shortSide < 720) {
    notes.push("Auflösung unter 720p: Gelenkpositionen sind spürbar unschärfer.");
    quality *= 0.8;
  }

  if (v.fps <= 0 || !Number.isFinite(v.fps)) {
    notes.push("Bildrate der Datei unbekannt.");
    fatal = true;
    quality = 0;
  }

  if (v.captureFps < v.fps) {
    notes.push(
      `Aufnahmerate (${v.captureFps} fps) kleiner als Wiedergaberate (${v.fps} fps) — ` +
        "die Angaben widersprechen sich. Zeitliche Größen werden gesperrt.",
    );
    quality *= 0.5;
  }

  const timing = timingAdmissibility(effectiveHz, 1);
  if (!timing.timingAllowed && timing.reason) notes.push(timing.reason);

  // Temporal regularity: dropped frames or a variable frame rate break every
  // derivative we compute.
  const gaps: number[] = [];
  for (let i = 1; i < req.frames.length; i++) gaps.push(req.frames[i].t - req.frames[i - 1].t);
  const medGap = median(gaps);
  let irregular = 0;
  if (medGap && medGap > 0) {
    irregular = gaps.filter((g) => Math.abs(g - medGap) > 0.4 * medGap).length;
    if (irregular > gaps.length * 0.05) {
      notes.push(`${irregular} unregelmäßige Bildabstände — Zeitableitungen werden unsicherer.`);
      quality *= clamp(1 - irregular / Math.max(1, gaps.length), 0.3, 1);
    }
  }

  // Frames with almost nothing detected are not analysable, whatever the
  // reason (player out of frame, cut, dark).
  const filled = req.frames.map((f) => Object.keys(f.pose2d).length);
  const meanFilled = mean(filled) ?? 0;
  const emptyish = filled.filter((n) => n < 6).length;
  if (emptyish > req.frames.length * 0.3) {
    notes.push(
      `In ${emptyish} von ${req.frames.length} Bildern wurde der Spieler kaum erkannt — ` +
        "vermutlich Bildausschnitt, Verdeckung oder Belichtung.",
    );
    quality *= 0.4;
  }

  const usableFrameCount = req.frames.length - emptyish;
  if (usableFrameCount < MIN_FRAMES) {
    fatal = true;
    quality = 0;
  }

  const status = fatal ? "failed" : quality < 0.65 ? "degraded" : "ok";

  return {
    report: {
      id: "L1",
      name: "Video-Ingestion & Qualitäts-Gate",
      status,
      quality: clamp(quality, 0, 1),
      notes,
      diagnostics: {
        fps: v.fps,
        captureFps: v.captureFps,
        effectiveHz,
        frames: req.frames.length,
        usableFrames: usableFrameCount,
        meanKeypointsPerFrame: Number(meanFilled.toFixed(1)),
        irregularGaps: irregular,
        timingAllowed: timing.timingAllowed ? "ja" : "nein",
      },
    },
    effectiveHz,
    dtScene,
    usableFrameCount,
    fatal,
  };
}

/** Strokes for which a dedicated phase model exists. */
export const SUPPORTED_STROKES: StrokeType[] = ["serve", "forehand", "backhand"];
