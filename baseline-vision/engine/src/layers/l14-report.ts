import { formatMeasure, band as confidenceBand, interval } from "../core/uncertainty.ts";
import type { LayerReport, PlayerProfile, StrokeType, VideoMeta } from "../core/types.ts";
import type { Feature } from "./l10-features.ts";
import type { Comparison, SelfComparison } from "./l11-reference.ts";
import type { QualityReport } from "./l12-confidence.ts";
import type { Finding, PlausibilityIssue, Verdict } from "./l13-interpretation.ts";
import type { Phase } from "./l09-segmentation.ts";
import { BALL_UNOBSERVABLE } from "./l08-ball.ts";

/**
 * Layer 14 — Coach-facing report.
 *
 * Assembles everything into one serialisable object. This is the contract
 * between the engine and any interface — the dashboard, an export, a future
 * mobile client — so it deliberately contains no presentation decisions, only
 * the facts and their provenance.
 *
 * It also carries the debugging view: for a professional product, "why is this
 * wrong?" has to be answerable without attaching a debugger, and the answer is
 * the per-layer status trail rather than the final number.
 */

export interface MetricRow {
  id: string;
  label: string;
  phase: string;
  value: number | null;
  sd: number | null;
  unit: string;
  formatted: string;
  interval95: [number, number] | null;
  confidence: number;
  confidenceLabel: string;
  observability: string;
  notes: string[];
  rejected: boolean;
  rejectionReason: string | null;
  reference: {
    mean: number;
    combinedSd: number;
    z: number | null;
    deviation: string;
    sourceId: string;
    cohortReasons: string[];
  } | null;
}

export interface NotMeasurable {
  id: string;
  label: string;
  reason: string;
}

export interface AnalysisReport {
  schemaVersion: 1;
  generatedAt: string;
  player: PlayerProfile;
  stroke: StrokeType;
  video: VideoMeta;

  quality: QualityReport;
  verdict: Verdict;
  findings: Finding[];
  issues: PlausibilityIssue[];

  phases: Phase[];
  contactFrame: number | null;
  contactConfidence: number;

  metrics: MetricRow[];
  notMeasurable: NotMeasurable[];
  selfComparisons: SelfComparison[];

  /** Per-layer trail, in execution order. */
  pipeline: LayerReport[];
}

export interface ReportInput {
  player: PlayerProfile;
  stroke: StrokeType;
  video: VideoMeta;
  layers: LayerReport[];
  features: Feature[];
  comparisons: Comparison[];
  selfComparisons: SelfComparison[];
  quality: QualityReport;
  findings: Finding[];
  issues: PlausibilityIssue[];
  verdict: Verdict;
  phases: Phase[];
  contactFrame: number | null;
  contactConfidence: number;
  now?: string;
}

export function buildReport(input: ReportInput): AnalysisReport {
  const comparisonById = new Map(input.comparisons.map((c) => [c.featureId, c]));

  const metrics: MetricRow[] = [];
  const notMeasurable: NotMeasurable[] = [];

  for (const f of input.features) {
    if (f.measure.value === null) {
      notMeasurable.push({
        id: f.id,
        label: f.label,
        reason: f.measure.notes[0] ?? "Nicht bestimmbar.",
      });
      continue;
    }
    const c = comparisonById.get(f.id);
    metrics.push({
      id: f.id,
      label: f.label,
      phase: f.phase,
      value: f.measure.value,
      sd: f.measure.sd,
      unit: f.measure.unit,
      formatted: formatMeasure(f.measure, f.measure.unit === "s" ? 3 : f.measure.unit === "m" ? 2 : 1),
      interval95: interval(f.measure),
      confidence: f.measure.confidence,
      confidenceLabel: confidenceBand(f.measure.confidence),
      observability: f.measure.observability,
      notes: f.measure.notes,
      rejected: Boolean(f.rejected),
      rejectionReason: f.rejected?.reason ?? null,
      reference:
        c && c.z !== null
          ? {
              mean: c.band.mean,
              combinedSd: c.combinedSd,
              z: c.z,
              deviation: c.deviation,
              sourceId: c.band.sourceId,
              cohortReasons: c.cohortReasons,
            }
          : null,
    });
  }

  // Quantities the system will never estimate from this input, stated with the
  // reason. Silently omitting them invites a coach to assume the tool measured
  // them and found nothing worth saying.
  for (const b of BALL_UNOBSERVABLE) {
    if (!notMeasurable.some((n) => n.id === b.id)) {
      notMeasurable.push({ id: b.id, label: b.label, reason: b.reason });
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: input.now ?? new Date().toISOString(),
    player: input.player,
    stroke: input.stroke,
    video: input.video,
    quality: input.quality,
    verdict: input.verdict,
    findings: input.findings,
    issues: input.issues,
    phases: input.phases,
    contactFrame: input.contactFrame,
    contactConfidence: input.contactConfidence,
    metrics,
    notMeasurable,
    selfComparisons: input.selfComparisons,
    pipeline: input.layers,
  };
}

/**
 * Plain-text rendering of the debugging trail, in the shape the brief asks for:
 *
 *     Pose Detection    -> OK
 *     Racket Tracking   -> Fehler
 *     Contact Detection -> unsicher
 *     Final Evaluation  -> verworfen
 */
export function renderPipelineTrail(report: AnalysisReport): string {
  const statusWord: Record<string, string> = {
    ok: "OK",
    degraded: "eingeschränkt",
    failed: "Fehler",
    skipped: "übersprungen",
  };
  const lines = report.pipeline.map(
    (l) => `${(l.id + " " + l.name).padEnd(42)} → ${statusWord[l.status]} (${l.quality.toFixed(2)})`,
  );
  lines.push(
    `${"Gesamtbewertung".padEnd(42)} → ${
      report.verdict.kind === "assessment"
        ? `${report.verdict.score}/100`
        : report.verdict.kind === "partial"
          ? `keine Note, ${report.verdict.measured.usable} Kenngrößen belastbar`
          : "nichts messbar"
    }`,
  );
  return lines.join("\n");
}

/** Short coach-facing summary; the first thing shown in the dashboard header. */
export function renderHeadline(report: AnalysisReport): string {
  const top = report.findings.find((f) => f.source !== "confirmation") ?? report.findings[0];
  if (report.verdict.kind !== "assessment") {
    // A partial result still has something to say, and the headline is where a
    // reader decides whether to keep reading.
    return top ? `${report.verdict.headline} ${top.observation}` : report.verdict.headline;
  }
  const base = `${report.verdict.score}/100 bei ${Math.round((report.verdict.confidence ?? 0) * 100)} % Sicherheit`;
  return top ? `${base}. Wichtigster Befund: ${top.observation}` : base;
}
