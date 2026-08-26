import { clamp, mean } from "../core/math.ts";
import type { LayerReport } from "../core/types.ts";
import type { Feature } from "./l10-features.ts";

/**
 * Layer 12 — Confidence estimation.
 *
 * Produces the Analysis Quality Score and its components. The score is not a
 * decoration: it is a gate. Below `MIN_QUALITY_FOR_VERDICT` the system does not
 * produce an overall assessment at all, whatever the individual numbers look
 * like.
 *
 * The components are reported separately because they fail separately and are
 * fixed separately. "Analysis quality 61" tells a coach nothing; "pose 94,
 * racket 78, ball 52, 3D 81" tells them to film from a different angle.
 */

export interface QualityComponent {
  id: string;
  label: string;
  score: number;
  /** What the coach can do about it, when there is something. */
  remedy: string | null;
  /**
   * False when the input never contained what this component measures — a clip
   * with no racket track, say. Such a component is left out of the score rather
   * than counted as zero: the recording is not worse for lacking something
   * nobody supplied, and marking it down would push clips below the verdict
   * threshold for a reason that has nothing to do with their quality.
   */
  applicable?: boolean;
}

export interface QualityReport {
  /** 0-100. */
  overall: number;
  components: QualityComponent[];
  /** Whether an overall technical assessment may be produced at all. */
  verdictAllowed: boolean;
  blockers: string[];
}

/**
 * Below this, no overall assessment is produced. The threshold is set where the
 * measurement uncertainty on the main features starts to exceed the spread of
 * the reference population — the point past which any verdict is a coin flip
 * dressed up as a number.
 */
export const MIN_QUALITY_FOR_VERDICT = 55;

export interface ConfidenceInput {
  layers: LayerReport[];
  features: Feature[];
  /** Layer ids that are indispensable; a failure in any of them blocks a verdict. */
  criticalLayers?: string[];
}

const DEFAULT_CRITICAL = ["L1", "L4", "L6", "L9"];

export function assessQuality(input: ConfidenceInput): QualityReport {
  const byId = new Map(input.layers.map((l) => [l.id, l]));
  const q = (id: string) => byId.get(id)?.quality ?? 0;

  const components: QualityComponent[] = [
    {
      id: "pose",
      label: "Pose-Tracking",
      score: Math.round(100 * Math.min(q("L4"), q("L5"))),
      remedy:
        "Bessere Ausleuchtung, den Spieler vollständig im Bild halten, Hintergrund mit weniger Bewegung.",
    },
    {
      id: "reconstruction",
      label: "3D-Rekonstruktion",
      score: Math.round(100 * q("L6")),
      remedy:
        "Kamera weiter weg und höher aufstellen, Platzlinien mit ins Bild nehmen, Brennweite dokumentieren.",
    },
    {
      id: "racket",
      label: "Schläger-Tracking",
      score: Math.round(100 * q("L7")),
      remedy: "Höhere Bildrate (120 fps oder mehr) und kürzere Belichtungszeit.",
    },
    {
      id: "ball",
      label: "Ball-Tracking",
      score: Math.round(100 * q("L8")),
      remedy: "Höhere Bildrate, kontrastreicher Hintergrund, Ball nicht gegen die Sonne filmen.",
    },
    {
      id: "segmentation",
      label: "Phasenerkennung",
      score: Math.round(100 * q("L9")),
      remedy: "Den gesamten Bewegungsablauf inklusive Landung aufnehmen, nicht erst kurz vor dem Treffpunkt.",
    },
    {
      id: "calibration",
      label: "Kamerakalibrierung",
      score: Math.round(100 * q("L2")),
      remedy: "Platzlinien im Bild lassen oder Kameradaten (Brennweite, Höhe, Abstand) einmalig erfassen.",
    },
  ];

  // Weighted mean, but with a floor rule: a single collapsed component drags the
  // whole score down rather than being averaged away. An analysis with perfect
  // pose tracking and no usable contact instant is not a good analysis.
  const weights: Record<string, number> = {
    pose: 0.28,
    reconstruction: 0.24,
    segmentation: 0.22,
    calibration: 0.12,
    racket: 0.09,
    ball: 0.05,
  };
  const layerOf: Record<string, string> = {
    pose: "L4",
    reconstruction: "L6",
    racket: "L7",
    ball: "L8",
    segmentation: "L9",
    calibration: "L2",
  };
  for (const c of components) {
    c.applicable = byId.get(layerOf[c.id] ?? "")?.status !== "skipped";
  }
  const applicable = components.filter((c) => c.applicable !== false);
  const weightSum = applicable.reduce((s, c) => s + (weights[c.id] ?? 0), 0);
  const weighted =
    weightSum > 0
      ? applicable.reduce((s, c) => s + c.score * (weights[c.id] ?? 0), 0) / weightSum
      : 0;
  const criticalIds = new Set(["pose", "reconstruction", "segmentation"]);
  const worstCritical = Math.min(...components.filter((c) => criticalIds.has(c.id)).map((c) => c.score));
  const overall = Math.round(clamp(Math.min(weighted, 35 + 0.65 * worstCritical), 0, 100));

  const blockers: string[] = [];
  const critical = input.criticalLayers ?? DEFAULT_CRITICAL;
  for (const id of critical) {
    const layer = byId.get(id);
    if (!layer) {
      blockers.push(`Ebene ${id} wurde nicht ausgeführt.`);
      continue;
    }
    if (layer.status === "failed") blockers.push(`${layer.name}: fehlgeschlagen.`);
  }

  const usable = input.features.filter((f) => f.measure.value !== null && !f.rejected && f.measure.confidence >= 0.35);
  if (usable.length < 3) {
    blockers.push(
      `Nur ${usable.length} belastbare Kenngrößen — zu wenig für eine Gesamteinschätzung ` +
        "(mindestens 3 erforderlich).",
    );
  }
  const rejected = input.features.filter((f) => f.rejected);
  if (rejected.length > input.features.length * 0.3) {
    blockers.push(
      `${rejected.length} von ${input.features.length} Kenngrößen lagen außerhalb des physiologisch ` +
        "Möglichen — die Pipeline arbeitet auf diesem Video nicht zuverlässig.",
    );
  }
  if (overall < MIN_QUALITY_FOR_VERDICT) {
    blockers.push(`Analysequalität ${overall}/100 liegt unter der Schwelle von ${MIN_QUALITY_FOR_VERDICT}.`);
  }

  return {
    overall,
    components,
    verdictAllowed: blockers.length === 0,
    blockers,
  };
}

/** Mean confidence of the features that survived, for the report header. */
export function meanFeatureConfidence(features: Feature[]): number {
  const usable = features.filter((f) => f.measure.value !== null && !f.rejected);
  return usable.length ? clamp(mean(usable.map((f) => f.measure.confidence)) ?? 0, 0, 1) : 0;
}
