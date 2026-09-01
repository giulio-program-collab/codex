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
   * Share of the analysis quality this component carries.
   *
   * Kept on the component so a reader — and the advice that picks the single
   * most effective next step — can tell a weak score on something that barely
   * matters from a weak score on something that decides the analysis.
   */
  weight?: number;
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
    c.weight = weights[c.id] ?? 0;
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

  // One cause, one sentence.
  //
  // Three separate rules used to fire on the same underlying fact — a video the
  // pipeline could not read — and the reader got three notices for it: too few
  // usable features, too many rejected ones, quality below a threshold whose
  // number means nothing to anyone outside this file. A person reading that
  // cannot tell whether they have one problem or three, and none of the three
  // says what to do. So the root causes are checked in order of severity and
  // only the first one that applies is reported, in the second person, with the
  // remedy attached.
  const usable = input.features.filter(
    (f) => f.measure.value !== null && !f.rejected && f.measure.confidence >= 0.35,
  );
  const rejected = input.features.filter((f) => f.rejected);
  const weakest = components
    .filter((c) => c.applicable !== false)
    .reduce((a, b) => (b.score < a.score ? b : a), components[0]);

  if (rejected.length > input.features.length * 0.4) {
    blockers.push(
      `${rejected.length} von ${input.features.length} Werten lagen außerhalb dessen, was ein Körper ` +
        "kann. Das spricht dafür, dass im Video zwischendurch eine andere Person verfolgt wurde " +
        "oder links und rechts vertauscht sind — nicht dafür, dass die Bewegung ungewöhnlich ist.",
    );
  } else if (usable.length === 0) {
    blockers.push(
      "Aus dieser Aufnahme ließ sich keine einzige Kenngröße sicher genug bestimmen, um sie zu nennen. " +
        (weakest?.remedy ?? "Eine Aufnahme mit besserer Perspektive oder höherer Bildrate hilft."),
    );
  } else if (overall < MIN_QUALITY_FOR_VERDICT) {
    blockers.push(
      `Die Aufnahme trägt einzelne Messwerte, aber nicht genug für ein Gesamturteil ` +
        `(Analysequalität ${overall} von 100, nötig sind ${MIN_QUALITY_FOR_VERDICT}). ` +
        `Am meisten bringt: ${lowerFirst(weakest?.remedy ?? "eine Aufnahme mit höherer Bildrate.")}`,
    );
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

/** "Kamera weiter weg …" → "kamera weiter weg …", for use mid-sentence. */
function lowerFirst(text: string): string {
  return text.length > 1 && text[1] === text[1].toLowerCase()
    ? text[0].toLowerCase() + text.slice(1)
    : text;
}
