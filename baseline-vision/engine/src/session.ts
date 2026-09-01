import { mad, mean, median, sd as sampleSd } from "./core/math.ts";
import type { AnalysisRequest, Measure, PlayerProfile, StrokeType } from "./core/types.ts";
import { band as confidenceBand } from "./core/uncertainty.ts";
import { analyse, type PipelineOptions } from "./pipeline.ts";
import type { DepthPrior } from "./layers/l06-lift3d.ts";
import { timingAdmissibility } from "./layers/l01-ingest.ts";
import { methodBiasFor, type Feature, type FeatureId } from "./layers/l10-features.ts";
import {
  SERVE_REFERENCES,
  compareToReference,
  type Comparison,
} from "./layers/l11-reference.ts";
import { buildFindings, type Finding } from "./layers/l13-interpretation.ts";
import type { AnalysisReport, MetricRow } from "./layers/l14-report.ts";

/**
 * Session-level analysis: several repetitions of the same stroke, together.
 *
 * This layer exists because of a rule the system imposes on itself. Layer 1
 * works out that inter-segment timing needs three repetitions at 120 Hz or five
 * at 60 Hz before a mean may be quoted, and layer 10 enforces it. A single clip
 * therefore *cannot* produce a timing comparison, by design — which would make
 * the most valuable part of the analysis permanently unreachable if there were
 * no way to hand the pipeline more than one stroke.
 *
 * It is also what a coach actually wants. "This serve was 78/100" is worth less
 * than "your contact height was steadier today than last week", and steadiness
 * is not a property of a stroke at all — it is a property of a set of them.
 */

/**
 * One repetition, with the per-clip inputs that belong to it.
 *
 * The depth prior lives here rather than in the session options because it is
 * indexed by frame *of this clip*. Handing one prior to every repetition would
 * look like it worked — the interface accepts a frame index and returns a
 * number — while silently reading the first serve's depths into the sixth.
 */
export interface SessionRepetition {
  request: AnalysisRequest;
  depthPrior?: DepthPrior;
}

export interface SessionRequest {
  player: PlayerProfile;
  stroke: StrokeType;
  /** One entry per repetition, in the order they were hit. */
  repetitions: SessionRepetition[];
  /** Session date, ISO. */
  date?: string;
}

export interface FeatureAggregate {
  featureId: FeatureId;
  label: string;
  unit: string;
  /** Values that survived outlier rejection, in repetition order. */
  values: number[];
  /** Repetitions that contributed after outlier rejection. */
  n: number;
  mean: number;
  median: number;
  /**
   * Spread between repetitions. This is the athlete's consistency, not a
   * measurement error — and for a coach it is often the more useful of the two.
   */
  sd: number | null;
  /** Coefficient of variation in percent, where the unit makes it meaningful. */
  cvPercent: number | null;
  /**
   * Uncertainty of the *mean*.
   *
   * The random part shrinks as 1/sqrt(n); the systematic part does not shrink
   * at all. Reporting sd/sqrt(n) alone would promise that thirty repetitions
   * measure a pelvis-peak lead to two milliseconds, which is false: the method
   * carries a bias of about twelve, and averaging a biased measurement thirty
   * times produces a very precise wrong answer.
   */
  sem: number;
  /** The systematic floor that survives averaging, in the feature's unit. */
  systematicFloor: number;
  /** Rejected repetitions, kept visible rather than silently dropped. */
  outliers: Array<{ repetition: number; value: number; deviations: number }>;
  /** Mean confidence of the contributing measurements. */
  confidence: number;
}

export interface SessionReport {
  schemaVersion: 1;
  date: string;
  player: PlayerProfile;
  stroke: StrokeType;
  /** One report per repetition, unchanged. */
  repetitions: AnalysisReport[];
  /** Repetitions whose own quality gate excluded them from the aggregate. */
  excluded: Array<{ repetition: number; reason: string }>;
  aggregates: FeatureAggregate[];
  /** Reference comparisons computed on the aggregated means. */
  comparisons: Comparison[];
  findings: Finding[];
  /** Timing admissibility for this session, given its rate and repetition count. */
  timing: ReturnType<typeof timingAdmissibility>;
  /** Median analysis quality across the contributing repetitions. */
  quality: number;
  notes: string[];
}

/**
 * A repetition whose analysis quality is below this does not enter the
 * aggregate. Averaging a bad measurement with good ones does not dilute it, it
 * contaminates them.
 */
export const MIN_REPETITION_QUALITY = 45;

/**
 * Outlier rejection threshold, in robust deviations from the median.
 * Applied only from five repetitions upward: below that the median absolute
 * deviation is itself too noisy to judge anything by, and rejecting a value out
 * of three is more likely to remove the truth than an error.
 */
export const OUTLIER_DEVIATIONS = 3.5;
export const MIN_REPETITIONS_FOR_OUTLIER_REJECTION = 5;

export interface SessionOptions extends PipelineOptions {
  /**
   * Called before each repetition is analysed. A session of six serves takes
   * long enough that an interface needs to say where it is.
   */
  onRepetition?: (index: number, count: number) => void;
}

export function analyseSession(request: SessionRequest, options: SessionOptions = {}): SessionReport {
  const notes: string[] = [];
  const count = request.repetitions.length;

  const reports = request.repetitions.map((rep, index) => {
    options.onRepetition?.(index, count);
    return analyse(
      { ...rep.request, player: request.player, stroke: request.stroke },
      { ...options, depthPrior: rep.depthPrior ?? options.depthPrior, repetitions: count },
    );
  });

  // --- Which repetitions may contribute --------------------------------
  const excluded: SessionReport["excluded"] = [];
  const usable: Array<{ index: number; report: AnalysisReport }> = [];
  reports.forEach((r, index) => {
    if (r.report.quality.overall < MIN_REPETITION_QUALITY) {
      excluded.push({
        repetition: index + 1,
        reason:
          `Analysequalität ${r.report.quality.overall}/100 liegt unter der Schwelle von ` +
          `${MIN_REPETITION_QUALITY}. Die Wiederholung geht nicht in den Mittelwert ein.`,
      });
      return;
    }
    usable.push({ index, report: r.report });
  });

  if (excluded.length > 0) {
    notes.push(
      `${excluded.length} von ${count} Wiederholungen wurden wegen unzureichender Aufnahmequalität ` +
        "nicht in die Auswertung aufgenommen.",
    );
  }

  const first = request.repetitions[0]?.request.video;
  const effectiveHz = first?.captureFps ?? first?.fps ?? 0;
  const timing = timingAdmissibility(effectiveHz, usable.length);
  if (!timing.timingAllowed && timing.reason) notes.push(timing.reason);

  // --- Aggregate each feature ------------------------------------------
  const metricIds = new Set<string>();
  for (const u of usable) for (const m of u.report.metrics) metricIds.add(m.id);

  const aggregates: FeatureAggregate[] = [];
  for (const id of metricIds) {
    const rows: Array<{ repetition: number; row: MetricRow }> = [];
    for (const u of usable) {
      const row = u.report.metrics.find((m) => m.id === id);
      if (!row || row.value === null || row.rejected || row.confidence < 0.35) continue;
      rows.push({ repetition: u.index + 1, row });
    }
    if (rows.length < 2) continue;

    const aggregate = aggregateFeature(id as FeatureId, rows);
    if (aggregate) aggregates.push(aggregate);
  }
  aggregates.sort((a, b) => a.featureId.localeCompare(b.featureId));

  // --- Compare the aggregated means against the references --------------
  // This is what the repetitions bought. A single stroke's timing may not be
  // scored against a population; the mean of enough of them may.
  const comparisons: Comparison[] = [];
  const aggregatedFeatures: Feature[] = aggregates.map((a) => toFeature(a, timing.timingAllowed));
  for (const feature of aggregatedFeatures) {
    const band = SERVE_REFERENCES.find((b) => b.featureId === feature.id);
    if (!band || feature.referenceEligible === false) continue;
    comparisons.push(compareToReference(feature, band, request.player));
  }

  const quality = median(usable.map((u) => u.report.quality.overall)) ?? 0;

  const findings = buildFindings({
    features: aggregatedFeatures,
    comparisons,
    selfComparisons: [],
    quality: {
      overall: Math.round(quality),
      components: usable[0]?.report.quality.components ?? [],
      verdictAllowed: usable.length > 0,
      blockers: [],
    },
  });

  return {
    schemaVersion: 1,
    date: request.date ?? new Date().toISOString().slice(0, 10),
    player: request.player,
    stroke: request.stroke,
    repetitions: reports.map((r) => r.report),
    excluded,
    aggregates,
    comparisons,
    findings,
    timing,
    quality: Math.round(quality),
    notes,
  };
}

/* ------------------------------------------------------------------ */

function aggregateFeature(
  id: FeatureId,
  rows: Array<{ repetition: number; row: MetricRow }>,
): FeatureAggregate | null {
  const label = rows[0].row.label;
  const unit = rows[0].row.unit;
  const raw = rows.map((r) => r.row.value as number);

  // --- Outlier rejection -----------------------------------------------
  const outliers: FeatureAggregate["outliers"] = [];
  let kept = rows;
  const reportedSd = mean(rows.map((r) => r.row.sd ?? 0)) as number;
  if (rows.length >= MIN_REPETITIONS_FOR_OUTLIER_REJECTION) {
    const centre = median(raw) as number;
    // The scale for judging an outlier is never allowed below the measurement's
    // own uncertainty.
    //
    // A robust deviation alone collapses when the repetitions happen to agree
    // closely: the median absolute deviation goes to almost nothing, and a
    // value a couple of millimetres from the median comes out at five sigma. A
    // value inside the measurement's own noise is not an outlier by any
    // definition worth having, however many robust deviations away it lands.
    const scale = Math.max(mad(raw) ?? 0, reportedSd);
    if (scale > 1e-9) {
      kept = [];
      rows.forEach((r) => {
        const deviations = Math.abs((r.row.value as number) - centre) / scale;
        if (deviations > OUTLIER_DEVIATIONS) {
          outliers.push({ repetition: r.repetition, value: r.row.value as number, deviations });
        } else {
          kept.push(r);
        }
      });
    }
  }
  if (kept.length < 2) return null;

  const values = kept.map((r) => r.row.value as number);
  const m = mean(values) as number;
  const med = median(values) as number;
  const between = sampleSd(values);
  const n = values.length;

  // The systematic floor is taken from the measured method bias rather than
  // inferred from the data.
  //
  // Inferring it as sqrt(reported^2 - between^2) is tempting and wrong in one
  // direction that matters: when the athlete genuinely varies a lot between
  // repetitions, `between` exceeds the reported measurement uncertainty, the
  // inferred floor collapses to zero, and the mean is then advertised as
  // sd/sqrt(n) precise — which promises that thirty repetitions pin down a
  // pelvis-peak lead to two milliseconds. They do not: the method carries a
  // bias of about twelve, and averaging a biased measurement thirty times just
  // produces a very precise wrong answer.
  const reported = mean(kept.map((r) => r.row.sd ?? 0)) as number;
  const systematicFloor = methodBiasFor(id);
  const randomPart = (between ?? reported) / Math.sqrt(n);
  const sem = Math.hypot(randomPart, systematicFloor);

  // A coefficient of variation needs a ratio scale — a zero that means "none of
  // it". A lead time measured relative to contact has an arbitrary zero, and a
  // quantity whose mean sits inside its own scatter gives a CV that swings
  // wildly for no physical reason. Both are excluded rather than shown with a
  // caveat, because a percentage looks authoritative wherever it appears.
  const ratioScale = unit !== "s" && m > 0;
  const wellSeparated = between !== null && m > 2 * between;
  const cvPercent = ratioScale && wellSeparated && between !== null ? (between / m) * 100 : null;

  return {
    featureId: id,
    label,
    unit,
    values,
    n,
    mean: m,
    median: med,
    sd: between,
    cvPercent,
    sem,
    systematicFloor,
    outliers,
    confidence: (mean(kept.map((r) => r.row.confidence)) as number) ?? 0,
  };
}

/** Wraps an aggregate as a `Feature`, so the existing layers can consume it. */
function toFeature(a: FeatureAggregate, timingAllowed: boolean): Feature {
  const isTiming = a.unit === "s";
  const measure: Measure = {
    value: a.mean,
    sd: a.sem,
    confidence: a.confidence,
    unit: a.unit,
    observability: "reconstructed",
    provenance: ["Session"],
    notes: [
      `Mittelwert aus ${a.n} Wiederholung${a.n === 1 ? "" : "en"}` +
        (a.sd !== null ? `, Streuung zwischen den Wiederholungen ${a.sd.toFixed(3)} ${a.unit}` : "") +
        ".",
      ...(a.systematicFloor > 0
        ? [
            `Davon sind ${a.systematicFloor.toFixed(3)} ${a.unit} systematisch und lassen sich durch ` +
              "weitere Wiederholungen nicht verringern.",
          ]
        : []),
      ...(a.outliers.length
        ? [
            `${a.outliers.length} Wiederholung(en) als Ausreißer ausgeschlossen: ` +
              a.outliers.map((o) => `#${o.repetition} (${o.value.toFixed(2)})`).join(", "),
          ]
        : []),
    ],
  };
  return {
    id: a.featureId,
    label: a.label,
    phase: "Sitzung",
    rationale: "",
    measure,
    referenceEligible: isTiming ? timingAllowed : true,
  };
}

/** Human-readable summary line for a session aggregate. */
export function formatAggregate(a: FeatureAggregate): string {
  const spread = a.sd === null ? "" : ` ± ${a.sd.toFixed(2)}`;
  const cv = a.cvPercent === null ? "" : ` · VK ${a.cvPercent.toFixed(1)} %`;
  return (
    `${a.label}: ${a.mean.toFixed(2)}${spread} ${a.unit} (n=${a.n})${cv} · ` +
    `Mittelwert auf ±${a.sem.toFixed(2)} ${a.unit} genau · ${confidenceBand(a.confidence)}`
  );
}
