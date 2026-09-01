import { clamp } from "../core/math.ts";
import {
  band as confidenceBand,
  formatMeasure,
  isActionable,
  isQuotable,
  probabilityBeyond,
} from "../core/uncertainty.ts";
import type { LayerReport, PlayerLevel, PlayerProfile } from "../core/types.ts";
import type { Feature, FeatureId } from "./l10-features.ts";
import type { Comparison, SelfComparison } from "./l11-reference.ts";
import type { QualityReport } from "./l12-confidence.ts";

/**
 * Layer 13 — Plausibility checking and interpretation.
 *
 * Two jobs, in this order.
 *
 * First, decide whether the analysis is allowed to say anything. That decision
 * is made from the pipeline's own diagnostics and from internal consistency,
 * not from whether the answer looks reasonable. A system that only questions
 * results it dislikes is not doing plausibility checking, it is doing wishful
 * thinking with extra steps.
 *
 * Second, translate what survived into a coach's language, with the observation
 * and its confidence attached to every claim.
 */

/* ------------------------------------------------------------------ */
/* Plausibility                                                        */
/* ------------------------------------------------------------------ */

export type IssueSeverity = "blocking" | "warning" | "info";

export interface PlausibilityIssue {
  id: string;
  severity: IssueSeverity;
  statement: string;
  /** Concrete numbers behind the statement, for the debug view. */
  evidence: string[];
  /** What to check, in pipeline order. */
  checklist?: string[];
}

export interface PlausibilityInput {
  player: PlayerProfile;
  layers: LayerReport[];
  features: Feature[];
  comparisons: Comparison[];
  quality: QualityReport;
  /** Composite score in [0, 100], before any decision about publishing it. */
  compositeScore: number | null;
}

/**
 * Score band a player of a given level would be expected to land in.
 *
 * This is the mechanism behind the Sinner test. It does not say "professionals
 * are always good, so never criticise them". It says: if the pipeline's own
 * output contradicts a strong prior about the subject, the *pipeline* is the
 * first suspect, and the analysis must be re-examined before anything is
 * published. The same rule fires in the other direction, when a developing
 * junior scores like a tour professional.
 */
const EXPECTED_BAND: Record<PlayerLevel, [number, number]> = {
  junior_development: [25, 80],
  junior_national: [35, 85],
  college: [40, 88],
  high_performance: [55, 95],
  elite: [70, 100],
};

export function runPlausibilityChecks(input: PlausibilityInput): PlausibilityIssue[] {
  const issues: PlausibilityIssue[] = [];
  const byLayer = new Map(input.layers.map((l) => [l.id, l]));

  // --- Pipeline-level faults -------------------------------------------
  for (const blocker of input.quality.blockers) {
    issues.push({
      id: "quality_gate",
      severity: "blocking",
      statement: blocker,
      evidence: input.quality.components.map((c) => `${c.label}: ${c.score}/100`),
    });
  }

  for (const layer of input.layers) {
    if (layer.status === "failed") {
      issues.push({
        id: `layer_failed_${layer.id}`,
        severity: "blocking",
        statement: `${layer.id} — ${layer.name}: fehlgeschlagen.`,
        evidence: layer.notes,
      });
    } else if (layer.status === "degraded") {
      issues.push({
        id: `layer_degraded_${layer.id}`,
        severity: "warning",
        statement: `${layer.id} — ${layer.name}: eingeschränkt (Güte ${layer.quality.toFixed(2)}).`,
        evidence: layer.notes,
      });
    }
  }

  // --- Rejected measurements -------------------------------------------
  const rejected = input.features.filter((f) => f.rejected);
  if (rejected.length > 0) {
    issues.push({
      id: "measurements_rejected",
      severity: rejected.length > 2 ? "blocking" : "warning",
      statement:
        `${rejected.length} Messung(en) lagen außerhalb des physiologisch Möglichen und wurden verworfen.`,
      evidence: rejected.map((f) => `${f.label}: ${f.rejected?.reason}`),
      checklist: [
        "Wurde durchgehend derselbe Spieler verfolgt?",
        "Sind Links und Rechts korrekt zugeordnet?",
        "Stimmen Bildrate und Aufnahmerate?",
        "Liegt die betroffene Körperachse in der relevanten Phase quer zur Kamera?",
      ],
    });
  }

  // --- Internal contradictions -----------------------------------------
  const byId = new Map(input.features.map((f) => [f.id, f]));
  const contradictions = findContradictions(byId);
  for (const c of contradictions) {
    issues.push({
      id: `contradiction_${c.id}`,
      severity: "warning",
      statement: c.statement,
      evidence: c.evidence,
      checklist: [
        "3D-Rekonstruktion: sind Tiefenrichtung und Vertikale plausibel?",
        "Treffpunkt: stimmen die unabhängigen Indizien überein?",
        "Phasensegmentierung: liegt der geprüfte Zeitpunkt in der richtigen Phase?",
      ],
    });
  }

  // --- Contact instant used but not trustworthy ------------------------
  const segmentation = byLayer.get("L9");
  const timingFeatures: FeatureId[] = ["pelvisPeakLead", "trunkPeakLead", "sequenceMargin"];
  const quotedTiming = timingFeatures.filter((id) => {
    const f = byId.get(id);
    return f && isQuotable(f.measure);
  });
  const contactConfidence = Number(segmentation?.diagnostics.treffpunktSicherheit ?? 0);
  if (quotedTiming.length > 0 && contactConfidence < 0.5) {
    issues.push({
      id: "timing_without_contact",
      severity: "blocking",
      statement:
        `Zeitliche Größen beziehen sich auf den Treffpunkt, dessen Bestimmung nur ` +
        `${Math.round(contactConfidence * 100)} % Sicherheit erreicht. Sie werden nicht ausgegeben.`,
      evidence: [`Betroffen: ${quotedTiming.join(", ")}`, ...(segmentation?.notes ?? [])],
    });
  }

  // --- Cohort mismatch dominating the comparison -----------------------
  const dominated = input.comparisons.filter(
    (c) => c.deviation === "nicht_unterscheidbar" && c.cohortReasons.length > 0,
  );
  if (dominated.length >= 2) {
    issues.push({
      id: "cohort_dominates",
      severity: "info",
      statement:
        "Bei mehreren Kenngrößen ist der Unterschied zur Referenzkohorte größer als der Unterschied " +
        "zwischen Spieler und Referenzwert. Ein Vergleich mit der eigenen Historie ist aussagekräftiger.",
      evidence: dominated.flatMap((c) => [`${c.featureId}: ${c.cohortReasons.join(" ")}`]),
    });
  }

  // --- The expectation check -------------------------------------------
  if (input.compositeScore !== null) {
    const [lo, hi] = EXPECTED_BAND[input.player.level];
    if (input.compositeScore < lo - 10 || input.compositeScore > hi + 10) {
      const direction = input.compositeScore < lo ? "deutlich unter" : "deutlich über";
      issues.push({
        id: "expectation_mismatch",
        severity: "blocking",
        statement:
          `Die technische Bewertung (${Math.round(input.compositeScore)}/100) liegt ${direction} dem, was ` +
          `für das angegebene Leistungsniveau "${input.player.level}" zu erwarten wäre (${lo}–${hi}). ` +
          "Bevor ein solches Ergebnis ausgegeben wird, muss die Analysekette überprüft werden.",
        evidence: [
          ...input.quality.components.map((c) => `${c.label}: ${c.score}/100`),
          ...input.comparisons
            .filter((c) => c.z !== null && Math.abs(c.z) > 1)
            .map((c) => `${c.featureId}: z = ${(c.z as number).toFixed(2)} (±${c.combinedSd.toFixed(2)})`),
        ],
        checklist: [
          "Ist die Pose in der relevanten Phase korrekt erkannt?",
          "Ist die Kameraperspektive für die betroffenen Größen überhaupt geeignet?",
          "Ist der Schläger korrekt erkannt?",
          "Ist der Treffpunkt korrekt erkannt?",
          "Sind die Bewegungsphasen korrekt segmentiert?",
          "Sind die 3D-Werte physiologisch plausibel?",
          "Passt die Referenzkohorte zu diesem Spieler?",
          "Widersprechen sich einzelne Messungen?",
          "Wie hoch ist die Unsicherheit der ausschlaggebenden Kenngrößen?",
        ],
      });
    }
  }

  return issues;
}

interface Contradiction {
  id: string;
  statement: string;
  evidence: string[];
}

/**
 * Cross-checks between features that are mechanically linked.
 *
 * These are the checks that catch a broken pipeline when every individual
 * number still looks possible. Physics does not allow a player to reach a
 * contact point 1.6 times their own height with no leg drive and a bent arm.
 */
function findContradictions(byId: Map<FeatureId, Feature>): Contradiction[] {
  const out: Contradiction[] = [];
  const value = (id: FeatureId): number | null => {
    const f = byId.get(id);
    return f && !f.rejected && f.measure.value !== null && f.measure.confidence >= 0.35
      ? f.measure.value
      : null;
  };

  const contactRatio = value("contactHeightRatio");
  const elbow = value("elbowFlexionAtContact");
  const shoulder = value("shoulderElevationAtContact");
  if (contactRatio !== null && elbow !== null && contactRatio > 1.5 && elbow > 45) {
    out.push({
      id: "reach_vs_elbow",
      statement:
        "Sehr hoher Treffpunkt bei gleichzeitig stark gebeugtem Ellbogen — geometrisch schwer vereinbar.",
      evidence: [
        `Treffpunkthöhe ${contactRatio.toFixed(2)} × Körperhöhe`,
        `Ellbogenflexion ${elbow.toFixed(0)}°`,
      ],
    });
  }
  if (contactRatio !== null && shoulder !== null && contactRatio > 1.5 && shoulder < 110) {
    out.push({
      id: "reach_vs_shoulder",
      statement: "Sehr hoher Treffpunkt bei gleichzeitig niedriger Schulterelevation — nicht konsistent.",
      evidence: [
        `Treffpunkthöhe ${contactRatio.toFixed(2)} × Körperhöhe`,
        `Schulterelevation ${shoulder.toFixed(0)}°`,
      ],
    });
  }

  const drive = value("legDriveRise");
  const racket = value("racketHeadPeakSpeed");
  if (drive !== null && racket !== null && drive < 0.08 && racket > 160) {
    out.push({
      id: "drive_vs_racket_speed",
      statement:
        "Hohe Schlägerkopfgeschwindigkeit ohne erkennbaren Beinantrieb — entweder ist der Beinantrieb " +
        "nicht messbar oder die Geschwindigkeit ist überschätzt.",
      evidence: [`Hubhöhe des Beckens ${(drive * 100).toFixed(0)} cm`, `Schlägerkopf ${racket.toFixed(0)} km/h`],
    });
  }

  const pelvisLead = value("pelvisPeakLead");
  const trunkLead = value("trunkPeakLead");
  const margin = value("sequenceMargin");
  if (pelvisLead !== null && trunkLead !== null && margin !== null) {
    const implied = trunkLead - pelvisLead;
    if (Math.abs(implied - margin) > 0.02) {
      out.push({
        id: "sequence_internal",
        statement: "Die Sequenz-Kennzahlen sind untereinander nicht konsistent.",
        evidence: [
          `Becken-Peak ${(pelvisLead * 1000).toFixed(0)} ms, Rumpf-Peak ${(trunkLead * 1000).toFixed(0)} ms`,
          `Daraus folgt ${(implied * 1000).toFixed(0)} ms, gemessen ${(margin * 1000).toFixed(0)} ms`,
        ],
      });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

export interface Finding {
  id: string;
  /** What was measured. Always a number with its uncertainty. */
  observation: string;
  /** Why it might matter, mechanically. */
  interpretation: string;
  /** What it could do to the stroke. */
  consequence: string;
  /** What to work on. Phrased as a hypothesis to test, never as an instruction. */
  recommendation: string;
  confidence: number;
  confidenceLabel: string;
  /** Ranking key: expected value of acting on this finding. */
  priority: number;
  source: "reference" | "self" | "consistency" | "confirmation";
}

export interface FindingInput {
  features: Feature[];
  comparisons: Comparison[];
  selfComparisons: SelfComparison[];
  quality: QualityReport;
}

const DRILLS: Partial<Record<FeatureId, string>> = {
  kneeFlexionPeak:
    "Ladephase isoliert üben: Aufschlagbewegung bis zur Trophy-Position, dort zwei Sekunden halten, " +
    "dann erst der Antrieb. Anschließend mit Video prüfen, ob die Beugung im Wettkampftempo erhalten bleibt.",
  trunkTiltAtTrophy:
    "Bogenspannung ohne Ball: Wurfarm-Position halten, Schulterachse geneigt, Hüfte vorschieben. " +
    "Mit einem Medizinball über Kopf beginnen, bevor der Schläger dazukommt.",
  shoulderElevationAtContact:
    "Treffpunkt hoch und vor dem Körper: Aufschläge gegen ein hoch gespanntes Band, das nur bei " +
    "gestrecktem Arm passiert wird.",
  elbowFlexionAtContact:
    "Pronation und Armstreckung getrennt vom Rest üben: Aufschläge nur aus dem Racket-Drop heraus, " +
    "ohne Beinantrieb, mit Fokus auf die Streckung im Treffpunkt.",
  pelvisPeakLead:
    "Rotationstiming: Medizinballwürfe rotational mit bewusst spätem Hüfteinsatz; danach Aufschläge " +
    "mit demselben Rhythmusgefühl.",
  trunkPeakLead:
    "Rumpfrotation gegen einen Widerstand (Kabelzug) im Aufschlagrhythmus, danach unmittelbar Aufschläge.",
  sequenceMargin:
    "Proximal-distale Reihenfolge über Zeitlupenvideo rückmelden: Becken zuerst, Rumpf danach. " +
    "Zunächst mit halber Geschwindigkeit, dann steigern.",
  legDriveRise:
    "Beinantrieb mit Zielhöhe: Aufschlagbewegung mit Absprung auf eine markierte Landeposition, " +
    "Landung kontrolliert im Feld.",
};

/**
 * Rule-based findings: mechanical facts that hold at every level.
 *
 * Not everything worth telling a coach is a statistical deviation from a
 * cohort. The proximal-to-distal ordering of a kinetic chain is not a
 * distribution a junior might sit at the edge of — it is a mechanical
 * requirement, and reversing it costs the same energy in a thirteen-year-old
 * as in a professional. Findings like these are the answer to two of the
 * brief's requirements at once: they let the system detect a developing
 * player's genuine deficits without measuring them against ATP means, and they
 * keep it from calling every difference from a professional a fault.
 *
 * Each rule states its own probability from the measurement's uncertainty, so
 * a rule never fires on a number that could just as easily be the other way
 * round.
 */
interface MechanicalRule {
  id: string;
  featureId: FeatureId;
  /** Threshold and side that constitute the fault. */
  threshold: number;
  direction: "above" | "below";
  /** Minimum probability that the true value is on the fault side. */
  minProbability: number;
  observation: (value: number, sd: number | null) => string;
  /**
   * What to say when the measurement clears the threshold with room to spare.
   *
   * A rule that only ever speaks up to complain is half a rule. "The sequence
   * is the right way round" is a real result — it is the thing the coach was
   * worried about, checked and cleared — and withholding it is why a clean
   * analysis used to come back as an empty panel.
   */
  confirmation: (value: number, sd: number | null) => string;
  interpretation: string;
  consequence: string;
  recommendation: string;
}

export const MECHANICAL_RULES: MechanicalRule[] = [
  {
    id: "sequence_reversed",
    featureId: "sequenceMargin",
    threshold: 0,
    direction: "below",
    minProbability: 0.85,
    observation: (v, sd) =>
      `Der Rumpf erreicht seine maximale Rotationsgeschwindigkeit ${Math.abs(v * 1000).toFixed(0)} ms ` +
      `vor dem Becken${sd !== null ? ` (± ${(sd * 1000).toFixed(0)} ms)` : ""} — die Reihenfolge ist umgekehrt.`,
    confirmation: (v, sd) =>
      `Das Becken erreicht seine maximale Rotationsgeschwindigkeit ${(v * 1000).toFixed(0)} ms ` +
      `vor dem Rumpf${sd !== null ? ` (± ${(sd * 1000).toFixed(0)} ms)` : ""} — die Reihenfolge der ` +
      "kinetischen Kette stimmt.",
    interpretation:
      "In einer intakten kinetischen Kette beschleunigt jedes Segment, während das darunterliegende " +
      "bereits abbremst. Dreht der Rumpf zuerst, fehlt ihm die Basis, gegen die er arbeiten könnte.",
    consequence:
      "Der Arm muss einen größeren Teil der Beschleunigung übernehmen. Das kostet Schlägerkopf" +
      "geschwindigkeit und erhöht die Belastung von Schulter und Ellbogen.",
    recommendation:
      "Reihenfolge vor Geschwindigkeit: Medizinball-Rotationswürfe mit bewusstem Hüfteinsatz zuerst, " +
      "danach Aufschläge im halben Tempo mit Videofeedback, bevor das Tempo wieder steigt.",
  },
  {
    id: "no_leg_drive",
    featureId: "legDriveRise",
    threshold: 0.1,
    direction: "below",
    minProbability: 0.85,
    observation: (v, sd) =>
      `Das Becken steigt zwischen tiefster Ladung und Treffpunkt nur ${(v * 100).toFixed(0)} cm` +
      `${sd !== null ? ` (± ${(sd * 100).toFixed(0)} cm)` : ""}.`,
    confirmation: (v, sd) =>
      `Das Becken steigt zwischen tiefster Ladung und Treffpunkt um ${(v * 100).toFixed(0)} cm` +
      `${sd !== null ? ` (± ${(sd * 100).toFixed(0)} cm)` : ""} — ein Beinantrieb ist da.`,
    interpretation:
      "Der Beinantrieb ist der Anfang der Kette und der einzige Punkt, an dem gegen den Boden " +
      "gearbeitet werden kann.",
    consequence:
      "Ohne vertikalen Antrieb sinkt der Treffpunkt, und der Aufschlag muss flacher gespielt werden, " +
      "um noch ins Feld zu gehen — das kostet Sicherheitsmarge über dem Netz.",
    recommendation:
      "Beinantrieb isoliert aufbauen: Ladephase halten, dann Absprung auf eine markierte Landeposition. " +
      "Zunächst ohne Ball, dann mit reduziertem Tempo.",
  },
  {
    id: "shallow_load",
    featureId: "kneeFlexionPeak",
    threshold: 25,
    direction: "below",
    minProbability: 0.85,
    observation: (v, sd) =>
      `Die maximale Knieflexion erreicht nur ${v.toFixed(0)}°${sd !== null ? ` (± ${sd.toFixed(0)}°)` : ""}.`,
    confirmation: (v, sd) =>
      `Die maximale Knieflexion erreicht ${v.toFixed(0)}°${sd !== null ? ` (± ${sd.toFixed(0)}°)` : ""} — ` +
      "eine Ladephase findet statt.",
    interpretation:
      "Unter etwa 25° findet praktisch keine Ladephase statt; die Bewegung beginnt faktisch im Rumpf.",
    consequence:
      "Die gesamte Beschleunigung muss von Rumpf und Arm geleistet werden, was sowohl Geschwindigkeit " +
      "kostet als auch die Schulter stärker belastet.",
    recommendation:
      "Ladephase separat üben: Aufschlagbewegung bis zur Trophy-Position, dort kurz halten, dann erst " +
      "der Antrieb. Danach im Video prüfen, ob die Beugung im Wettkampftempo erhalten bleibt.",
  },
];

/**
 * How many confirmations a report may carry.
 *
 * Enough that a clean analysis is not an empty page, few enough that the things
 * worth working on stay at the top of it.
 */
export const MAX_CONFIRMATIONS = 4;

export function buildFindings(input: FindingInput): Finding[] {
  const findings: Finding[] = [];
  const confirmations: Finding[] = [];
  const byId = new Map(input.features.map((f) => [f.id, f]));

  for (const rule of MECHANICAL_RULES) {
    const feature = byId.get(rule.featureId);
    if (!feature || feature.rejected || !isQuotable(feature.measure)) continue;
    const p = probabilityBeyond(feature.measure, rule.threshold, rule.direction);
    if (p === null) continue;
    // The same rule, read from the other side. If the true value is on the safe
    // side of the threshold with the same certainty the fault would require,
    // that is a result and it is said out loud.
    if (1 - p >= rule.minProbability) {
      const confidence = clamp(feature.measure.confidence * (1 - p), 0, 0.95);
      confirmations.push({
        id: `ok_${rule.id}`,
        observation: rule.confirmation(feature.measure.value as number, feature.measure.sd),
        interpretation: rule.interpretation,
        consequence: "An dieser Stelle ist nichts zu ändern.",
        recommendation:
          "Kein Handlungsbedarf. Bei der nächsten Aufnahme prüfen, ob es so bleibt.",
        confidence,
        confidenceLabel: confidenceBand(confidence),
        priority: confidence,
        source: "confirmation",
      });
      continue;
    }
    if (p < rule.minProbability) continue;
    const confidence = clamp(feature.measure.confidence * p, 0, 0.95);
    findings.push({
      id: `rule_${rule.id}`,
      observation: rule.observation(feature.measure.value as number, feature.measure.sd),
      interpretation: rule.interpretation,
      consequence: rule.consequence,
      recommendation: isActionable(feature.measure)
        ? rule.recommendation
        : "Vor einer Trainingsempfehlung sollte eine Aufnahme mit besserer Perspektive oder höherer " +
          "Bildrate bestätigen, dass das Muster reproduzierbar ist.",
      confidence,
      confidenceLabel: confidenceBand(confidence),
      // Mechanical faults outrank statistical deviations: they hold regardless
      // of who the player is being compared with.
      priority: 4 + confidence * 2,
      source: "consistency",
    });
  }

  for (const c of input.comparisons) {
    const feature = byId.get(c.featureId);
    if (!feature || feature.rejected) continue;
    if (c.z === null || c.probabilityOfConcern === null) continue;
    if (!isQuotable(feature.measure)) continue;
    // Only deviations that are both large relative to the *combined* spread and
    // on the mechanically meaningful side become findings. Everything else is
    // a number in the table, not advice.
    if (c.deviation === "im_band") {
      // A value inside the band, measured well enough that a deviation would
      // have shown, is the answer to "is there anything wrong with this?" —
      // and the answer is no. Only an informative comparison may say it: on a
      // comparison too blunt to distinguish, "inside the band" means nothing.
      if (c.informative && c.confidence >= 0.5) {
        confirmations.push({
          id: `ok_ref_${c.featureId}`,
          observation:
            `${feature.label}: ${formatMeasure(feature.measure, feature.measure.unit === "s" ? 3 : 1)} — ` +
            `im Bereich der Referenz (${c.band.mean}${c.band.unit} ± ` +
            `${c.combinedSd.toFixed(c.band.unit === "s" ? 3 : 1)}${c.band.unit}, ${c.band.sourceId}).`,
          interpretation: c.band.mechanism,
          consequence:
            "Diese Aufnahme zeigt hier keine Abweichung, für die es einen Wirkmechanismus gäbe.",
          recommendation: "Kein Handlungsbedarf.",
          confidence: c.confidence,
          confidenceLabel: confidenceBand(c.confidence),
          priority: c.confidence,
          source: "confirmation",
        });
      }
      continue;
    }
    if (c.deviation === "nicht_unterscheidbar") continue;
    // A band whose measurement convention we could not confirm is context, not
    // evidence.
    if (!c.informative) continue;
    if (c.probabilityOfConcern < 0.75) continue;

    const strong = c.deviation === "deutlich_abweichend";
    const actionable = isActionable(feature.measure) && c.confidence >= 0.5;
    const confidence = clamp(c.confidence * (strong ? 1 : 0.85), 0, 1);

    findings.push({
      id: `ref_${c.featureId}`,
      observation:
        `${feature.label}: ${formatMeasure(feature.measure, feature.measure.unit === "s" ? 3 : 1)}. ` +
        `Referenz ${c.band.mean}${c.band.unit} ± ${c.combinedSd.toFixed(c.band.unit === "s" ? 3 : 1)}${c.band.unit} ` +
        `(${c.band.sourceId}), Abstand ${c.z.toFixed(1)} Standardabweichungen.`,
      interpretation: c.band.mechanism,
      consequence: consequenceFor(c),
      recommendation: actionable
        ? DRILLS[c.featureId] ??
          "Diesen Aspekt gezielt im Video prüfen und über mehrere Einheiten beobachten."
        : "Für eine belastbare Empfehlung reicht die Messsicherheit nicht. Zunächst eine Aufnahme mit " +
          "geeigneterer Perspektive oder höherer Bildrate erstellen.",
      confidence,
      confidenceLabel: confidenceBand(confidence),
      priority: confidence * Math.min(Math.abs(c.z), 4),
      source: "reference",
    });
  }

  for (const s of input.selfComparisons) {
    if (!s.meaningful) continue;
    const feature = byId.get(s.featureId);
    if (!feature) continue;
    const direction = s.delta > 0 ? "höher" : "niedriger";
    findings.push({
      id: `self_${s.featureId}`,
      observation:
        `${feature.label} liegt ${Math.abs(s.delta).toFixed(2)} ${feature.measure.unit} ${direction} als im ` +
        `Mittel der letzten ${s.sampleCount} Aufnahmen (${s.historyMean.toFixed(2)} ± ${s.historySd.toFixed(2)}).`,
      interpretation:
        "Veränderungen innerhalb desselben Spielers sind deutlich besser bestimmt als absolute Werte: " +
        "systematische Messfehler heben sich weitgehend auf.",
      consequence:
        "Dieses Muster unterscheidet sich von der bisherigen Bewegung des Spielers und könnte untersucht werden.",
      recommendation:
        "Prüfen, ob die Veränderung beabsichtigt war. Falls ja, über die nächsten Einheiten beobachten, " +
        "ob sie stabil bleibt.",
      confidence: clamp(s.probabilityOfRealChange, 0, 0.95),
      confidenceLabel: confidenceBand(s.probabilityOfRealChange),
      priority: s.probabilityOfRealChange * 2.5,
      source: "self",
    });
  }

  confirmations.sort((a, b) => b.confidence - a.confidence);
  return [
    ...findings.sort((a, b) => b.priority - a.priority),
    ...confirmations.slice(0, MAX_CONFIRMATIONS),
  ];
}

function consequenceFor(c: Comparison): string {
  const side = (c.z ?? 0) < 0 ? "niedriger" : "höher";
  return (
    `Der gemessene Wert liegt ${side} als die Referenz. Ob das für diesen Spieler nachteilig ist, hängt ` +
    "vom Rest der Bewegung ab — Körperbau, Timing und Schlagabsicht können denselben Wert sinnvoll machen. " +
    "Der Befund ist ein Prüfauftrag, keine Fehlermeldung."
  );
}

/* ------------------------------------------------------------------ */
/* Verdict                                                             */
/* ------------------------------------------------------------------ */

export interface ScoreComponent {
  id: string;
  label: string;
  score: number;
  weight: number;
  /** Which features contributed, so the number can always be traced back. */
  basedOn: FeatureId[];
}

/**
 * What the analysis is able to offer.
 *
 * There used to be two of these, and the missing third one was the whole
 * problem with the product. A recording that yields fifteen measurements with
 * honest intervals but no composite score is not the same thing as a recording
 * that yields nothing, and telling a user "keine zuverlässige Bewertung
 * möglich" in both cases throws away the work in the first. `partial` is that
 * middle state, and it is the ordinary one: a single serve filmed on a phone
 * can be measured well and still not support a grade, because the grade needs
 * reference comparisons that a single repetition cannot provide.
 */
export type VerdictKind = "assessment" | "partial" | "no_reliable_assessment";

export interface Verdict {
  kind: VerdictKind;
  /** Only present for `assessment`. */
  score?: number;
  confidence?: number;
  components?: ScoreComponent[];
  /** One line, in the reader's language, for the top of the report. */
  headline: string;
  /** Always present: what this is, and what it is not. */
  statement: string;
  reasons: string[];
  /** How many features carried a usable value, out of how many were attempted. */
  measured: { usable: number; total: number };
  /** The single most effective change to the next recording, when there is one. */
  nextStep: string | null;
}

/**
 * Builds the composite score from the comparisons.
 *
 * Every component is traceable to named features, and the weights are visible.
 * The number is offered as a summary of the components, never as the truth of
 * the stroke — which is why the report always shows the components next to it
 * and why the whole thing is suppressed when the components are not credible.
 */
/**
 * Minimum number of informative comparisons behind a composite score. Below
 * this the "score" would be an opinion about two numbers, dressed as a verdict.
 */
export const MIN_SCORING_FEATURES = 3;

export function composeScore(comparisons: Comparison[], features: Feature[]): {
  score: number | null;
  components: ScoreComponent[];
} {
  const byId = new Map(features.map((f) => [f.id, f]));
  const groups: Array<{ id: string; label: string; weight: number; ids: FeatureId[] }> = [
    { id: "chain", label: "Kinetische Kette", weight: 0.3, ids: ["kneeFlexionPeak", "trunkTiltAtTrophy", "hipShoulderSeparationPeak"] },
    { id: "timing", label: "Timing", weight: 0.3, ids: ["pelvisPeakLead", "trunkPeakLead", "sequenceMargin"] },
    { id: "contact", label: "Treffpunkt", weight: 0.25, ids: ["shoulderElevationAtContact", "elbowFlexionAtContact", "contactHeightRatio"] },
    { id: "balance", label: "Balance", weight: 0.15, ids: ["legDriveRise", "landingLateralShift"] },
  ];

  const components: ScoreComponent[] = [];
  for (const g of groups) {
    const parts: number[] = [];
    const used: FeatureId[] = [];
    for (const id of g.ids) {
      const c = comparisons.find((x) => x.featureId === id);
      const f = byId.get(id);
      if (!f || f.rejected || f.measure.value === null || f.measure.confidence < 0.35) continue;
      // Only comparisons that could actually have detected a deviation may
      // move the score. Otherwise a worse video produces a better result.
      if (!c || c.z === null || !c.informative) continue;
      // A value inside the combined band scores full marks. The penalty grows
      // with distance from the band, and only on the side that carries a
      // mechanism — being *more* flexed than the reference is not a fault when
      // the mechanism only warns about being less flexed.
      const signed =
        c.band.concernDirection === "below"
          ? Math.min(0, c.z)
          : c.band.concernDirection === "above"
            ? Math.min(0, -c.z)
            : -Math.abs(c.z);
      parts.push(clamp(100 - 18 * Math.abs(signed), 0, 100));
      used.push(id);
    }
    if (parts.length === 0) continue;
    components.push({
      id: g.id,
      label: g.label,
      score: Math.round(parts.reduce((s, v) => s + v, 0) / parts.length),
      weight: g.weight,
      basedOn: used,
    });
  }

  const contributing = components.reduce((s, c) => s + c.basedOn.length, 0);
  if (components.length === 0 || contributing < MIN_SCORING_FEATURES) {
    return { score: null, components };
  }
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const score = components.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
  return { score, components };
}

/**
 * The one change to the next recording that would buy the most.
 *
 * Ranking by the lowest score alone gives bad advice: ball tracking carries a
 * twentieth of the analysis quality, so it is usually the weakest component and
 * usually not worth anyone's afternoon. What matters is how much of the score
 * is actually lost there — the shortfall times the weight — and below a couple
 * of points of recoverable quality there is nothing worth saying at all.
 */
const WORTH_MENTIONING = 2.5;

function nextStepFrom(quality: QualityReport): string | null {
  const ranked = quality.components
    .filter((c) => c.applicable !== false && c.remedy !== null)
    .map((c) => ({ c, gain: (c.weight ?? 0) * (100 - c.score) }))
    .sort((a, b) => b.gain - a.gain);
  const best = ranked[0];
  return best && best.gain >= WORTH_MENTIONING ? (best.c.remedy as string) : null;
}

export function decideVerdict(
  compositeScore: number | null,
  components: ScoreComponent[],
  quality: QualityReport,
  issues: PlausibilityIssue[],
  featureConfidence: number,
  features: Feature[],
): Verdict {
  const blocking = issues.filter((i) => i.severity === "blocking");
  const usable = features.filter(
    (f) => f.measure.value !== null && !f.rejected && isQuotable(f.measure),
  );
  const measured = { usable: usable.length, total: features.length };
  const nextStep = nextStepFrom(quality);

  // Nothing survived. This is the only case that is genuinely a refusal.
  if (usable.length === 0) {
    return {
      kind: "no_reliable_assessment",
      headline: "Aus dieser Aufnahme lässt sich nichts messen.",
      statement:
        "Kein einziger Wert war sicher genug zu bestimmen, um ihn zu nennen. Das ist eine Aussage " +
        "über die Aufnahme, nicht über den Aufschlag.",
      reasons: quality.blockers.length ? quality.blockers : blocking.map((b) => b.statement),
      measured,
      nextStep,
    };
  }

  // Measurements exist, but no grade. The ordinary case, and not a failure:
  // the report below it is full.
  if (compositeScore === null || blocking.length > 0) {
    const why =
      compositeScore === null
        ? `Für eine Gesamtnote braucht es ${MIN_SCORING_FEATURES} Kenngrößen, die sich mit einer ` +
          "Referenzgruppe vergleichen lassen. Aus einem einzelnen Aufschlag sind es meist weniger — " +
          "die Timing-Größen etwa tragen erst im Mittel aus mehreren Wiederholungen."
        : "Die Prüfung der Pipeline hat Gründe ergeben, einer Gesamtnote nicht zu trauen. Die " +
          "einzelnen Messwerte bleiben davon unberührt.";
    return {
      kind: "partial",
      headline:
        usable.length === 1
          ? "Eine Kenngröße ist belastbar — für eine Gesamtnote reicht es nicht."
          : `${usable.length} Kenngrößen sind belastbar — für eine Gesamtnote reicht es nicht.`,
      statement:
        "Die Messwerte unten gelten, jeder mit seinem Intervall. Was fehlt, ist die eine Zahl " +
        "darüber — und die fehlt aus einem benennbaren Grund, nicht aus Vorsicht.",
      reasons: [why, ...quality.blockers, ...blocking.map((b) => b.statement)],
      measured,
      nextStep,
    };
  }
  const rounded = Math.round(compositeScore);
  const contributing = components.reduce((s, c) => s + c.basedOn.length, 0);
  const reasons = [
    `Der Wert stützt sich auf ${contributing} von ${TOTAL_SCORABLE_FEATURES} möglichen Kenngrößen; ` +
      "die übrigen waren in diesem Video nicht genau genug messbar, um überhaupt etwas zu unterscheiden.",
  ];
  // A high score has to be read correctly, or it becomes the same kind of
  // false precision as a low one. It does not say the technique is perfect: it
  // says that on every dimension this video could resolve, nothing deviated
  // from the reference band in the direction that carries a mechanism.
  if (rounded >= 95) {
    reasons.unshift(
      "Auf keiner der messbaren Dimensionen liegt eine Abweichung vor, für die es einen " +
        "biomechanischen Wirkmechanismus gäbe. Das heißt nicht „technisch perfekt“, sondern: " +
        "Dieses Video zeigt nichts, was sich belegbar von der Referenz unterscheidet.",
    );
  }
  return {
    kind: "assessment",
    score: rounded,
    confidence: clamp(featureConfidence * (quality.overall / 100), 0, 1),
    components,
    headline: "Diese Aufnahme trägt eine Bewertung.",
    statement:
      "Die Bewertung setzt sich aus den unten aufgeführten Teilwerten zusammen und gilt nur für die " +
      "Größen, die in diesem Video messbar waren.",
    reasons,
    measured,
    nextStep,
  };
}

/** How many features the composite score could draw on if everything were measurable. */
const TOTAL_SCORABLE_FEATURES = 11;
