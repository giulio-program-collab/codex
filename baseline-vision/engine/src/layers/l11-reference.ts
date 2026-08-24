import { clamp, normalCdf } from "../core/math.ts";
import type { Measure, PlayerLevel, PlayerProfile } from "../core/types.ts";
import type { Feature, FeatureId } from "./l10-features.ts";

/**
 * Layer 11 — Reference comparison.
 *
 * The old tool compared a junior's 2D-digitised angles against means published
 * for ATP professionals measured with an eight-camera Vicon rig at 400 Hz, and
 * scored the difference. Two things were wrong with that, and they are
 * different mistakes:
 *
 *  1. The measurement and the reference were not the same quantity. A projected
 *     image angle and an ISB-normalised joint angle differ by whatever the
 *     camera geometry does, which can be tens of degrees.
 *
 *  2. The cohort did not match. A 13-year-old developing player is not a small
 *     adult professional. Comparing them is legitimate — coaches do it all day
 *     — but the *uncertainty* of that comparison is much larger than the
 *     study's own standard deviation, and pretending otherwise turns normal
 *     developmental variation into a technical fault.
 *
 * The fix for (1) lives in layers 6 and 10. The fix for (2) is here: a cohort
 * mismatch widens the reference band rather than shifting it. A player outside
 * the reference cohort is not judged more harshly and not more leniently — they
 * are judged less *confidently*, which is the honest consequence.
 */

export interface ReferenceSource {
  id: string;
  label: string;
  note: string;
  /** Population the values were measured on. */
  cohort: {
    level: PlayerLevel;
    sampleSize: number;
    meanHeightCm?: number;
    adult: boolean;
  };
  /** How the reference values were obtained; decides comparability. */
  method: "optical_motion_capture" | "markerless_3d" | "video_2d" | "radar" | "derived";
}

export const REFERENCE_SOURCES: Record<string, ReferenceSource> = {
  frontiers24: {
    id: "frontiers24",
    label: "Frontiers in Sports and Active Living (2024)",
    note: "Systematische Übersicht und Metaanalyse über 27 Studien zur Aufschlagkinematik, ISB-normalisiert.",
    cohort: { level: "elite", sampleSize: 27, meanHeightCm: 185, adult: true },
    method: "optical_motion_capture",
  },
  landlinger10: {
    id: "landlinger10",
    label: "Journal of Sports Science & Medicine 9(4), 643–651 (2010)",
    note: "8-Kamera-Vicon, 400 Hz. 6 ATP-Profis gegen 7 High-Performance-Spieler.",
    cohort: { level: "elite", sampleSize: 13, meanHeightCm: 184, adult: true },
    method: "optical_motion_capture",
  },
  elliott: {
    id: "elliott",
    label: "Elliott, Biomechanics and Tennis (Br J Sports Med)",
    note: "Treffpunktlage und Treffpunkthöhe im Aufschlag und in der Rückhand.",
    cohort: { level: "high_performance", sampleSize: 20, meanHeightCm: 182, adult: true },
    method: "optical_motion_capture",
  },
  self: {
    id: "self",
    label: "Eigene Historie",
    note: "Frühere Aufnahmen desselben Spielers, mit derselben Pipeline ausgewertet.",
    cohort: { level: "junior_development", sampleSize: 0, adult: false },
    method: "markerless_3d",
  },
};

export interface ReferenceBand {
  featureId: FeatureId;
  mean: number;
  sd: number;
  unit: string;
  sourceId: string;
  /** Direction in which a deviation is mechanically meaningful, if any. */
  concernDirection: "below" | "above" | "both" | "none";
  /** What the deviation would mechanically imply; never a verdict on its own. */
  mechanism: string;
  /**
   * Whether the quantity this system measures is confirmed to be the same
   * quantity the source measured.
   *
   * This is the first of the two mistakes described above, made explicit. Joint
   * angles have several incompatible conventions — ISB elevation, abduction in
   * the scapular plane, an angle from the trunk axis, an angle from the
   * horizontal — and published papers do not always say which one they used.
   * Where the convention cannot be confirmed, the band is still shown as
   * context but is never scored and never produces a finding, because a
   * definitional offset of fifty degrees is indistinguishable from a technical
   * fault of fifty degrees.
   */
  definitionMatch: "verified" | "unverified";
  /** Present when `definitionMatch` is "unverified": what exactly is unclear. */
  definitionNote?: string;
}

/**
 * Published reference bands.
 *
 * Only quantities with a genuine published distribution appear here. Where a
 * distribution does not exist — contact height for juniors, for instance — the
 * feature is compared against the player's own history and against nothing
 * else. Inventing a band for it would be the most damaging kind of fabrication
 * this system can commit, because it would look exactly like the real ones.
 */
export const SERVE_REFERENCES: ReferenceBand[] = [
  {
    featureId: "kneeFlexionPeak",
    mean: 64.5,
    sd: 9.7,
    unit: "°",
    sourceId: "frontiers24",
    concernDirection: "below",
    definitionMatch: "verified",
    mechanism:
      "Zu wenig Kniebeugung verkürzt den Beinantrieb. Die fehlende Kraft muss weiter oben in der Kette " +
      "erzeugt werden, meist von Rumpf und Schulter.",
  },
  {
    featureId: "trunkTiltAtTrophy",
    mean: 25,
    sd: 7.1,
    unit: "°",
    sourceId: "frontiers24",
    concernDirection: "below",
    definitionMatch: "verified",
    mechanism:
      "Ohne Rumpfneigung entsteht keine Bogenspannung; der Aufschlag wird überwiegend aus dem Arm gespielt.",
  },
  {
    featureId: "shoulderElevationAtContact",
    mean: 110.7,
    sd: 16.9,
    unit: "°",
    sourceId: "frontiers24",
    concernDirection: "below",
    // The published figure is around 110 degrees, but this system measures the
    // angle between the trunk's long axis and the humerus, on which a serve at
    // contact sits near 160-170 degrees. Those two numbers are almost certainly
    // different conventions rather than a sixty-degree technical fault, and
    // until the source's convention is confirmed against its own methods
    // section, comparing them would manufacture a finding out of a definition.
    definitionMatch: "unverified",
    definitionNote:
      "Die Winkelkonvention der Quelle (ISB-Elevation, Abduktion in der Skapularebene oder Winkel zur " +
      "Rumpflängsachse) ist nicht gesichert. Der Wert wird als Kontext angezeigt, aber nicht bewertet.",
    mechanism: "Eine tiefe Elevation im Treffpunkt kostet Treffpunkthöhe und erhöht die Schulterlast.",
  },
  {
    featureId: "elbowFlexionAtContact",
    mean: 30.1,
    sd: 15.9,
    unit: "°",
    sourceId: "frontiers24",
    concernDirection: "above",
    definitionMatch: "verified",
    mechanism:
      "Ein stark gebeugter Arm im Treffpunkt verkürzt den Hebel und unterbricht die Beschleunigung " +
      "aus Unterarm und Handgelenk.",
  },
  {
    featureId: "pelvisPeakLead",
    mean: -0.075,
    sd: 0.008,
    unit: "s",
    sourceId: "landlinger10",
    concernDirection: "below",
    definitionMatch: "verified",
    mechanism:
      "Ein sehr früher Becken-Peak bedeutet, dass die Rotation weit vor dem Treffpunkt abgeschlossen ist " +
      "und ihr Beitrag zur Schlägergeschwindigkeit verpufft.",
  },
  {
    featureId: "trunkPeakLead",
    mean: -0.057,
    sd: 0.004,
    unit: "s",
    sourceId: "landlinger10",
    concernDirection: "below",
    definitionMatch: "verified",
    mechanism: "Wie beim Becken, eine Stufe höher in der Kette.",
  },
  {
    featureId: "sequenceMargin",
    mean: 0.018,
    sd: 0.009,
    unit: "s",
    sourceId: "landlinger10",
    concernDirection: "below",
    definitionMatch: "verified",
    mechanism:
      "Der Rumpf muss nach dem Becken beschleunigen. Kehrt sich die Reihenfolge um, arbeitet die Kette " +
      "gegen sich selbst und der Arm muss den Verlust ausgleichen.",
  },
];

/* ------------------------------------------------------------------ */
/* Cohort mismatch                                                     */
/* ------------------------------------------------------------------ */

const LEVEL_ORDER: PlayerLevel[] = [
  "junior_development",
  "junior_national",
  "college",
  "high_performance",
  "elite",
];

/**
 * Extra spread, as a multiple of the reference SD, introduced by comparing a
 * player to a cohort they do not belong to.
 *
 * These numbers are deliberately conservative and are the part of the system
 * most in need of empirical calibration against real cohort data. They encode
 * three separate effects: performance level, body size, and — the one most
 * often forgotten — the measurement method. A value from an eight-camera Vicon
 * rig and a value from a single phone are not the same measurement, and the
 * difference between them is not covered by the study's standard deviation.
 */
export function cohortMismatchSd(band: ReferenceBand, player: PlayerProfile): { sd: number; reasons: string[] } {
  const source = REFERENCE_SOURCES[band.sourceId];
  const reasons: string[] = [];
  let factor = 0;

  const levelGap = Math.abs(LEVEL_ORDER.indexOf(player.level) - LEVEL_ORDER.indexOf(source.cohort.level));
  if (levelGap > 0) {
    factor += 0.35 * levelGap;
    reasons.push(`Leistungsniveau unterscheidet sich um ${levelGap} Stufe(n) von der Referenzkohorte.`);
  }

  if (source.cohort.meanHeightCm) {
    const relative = Math.abs(player.heightCm - source.cohort.meanHeightCm) / source.cohort.meanHeightCm;
    if (relative > 0.05) {
      factor += 3 * (relative - 0.05);
      reasons.push(
        `Körperhöhe weicht um ${Math.round(relative * 100)} % vom Mittel der Referenzkohorte ab.`,
      );
    }
  }

  if (source.cohort.adult && player.ageYears !== undefined && player.ageYears < 16) {
    factor += 0.5;
    reasons.push("Erwachsenen-Referenz für einen Spieler im Wachstum.");
  }

  if (source.method === "optical_motion_capture") {
    // The reference was measured in a laboratory; this measurement was not.
    factor += 0.6;
    reasons.push(
      "Referenzwerte stammen aus Labor-Motion-Capture, die Messung aus einer einzelnen Kamera. " +
        "Die Verfahren sind nicht deckungsgleich.",
    );
  }

  if (source.cohort.sampleSize > 0 && source.cohort.sampleSize < 15) {
    factor += 0.25;
    reasons.push(`Referenz beruht auf nur ${source.cohort.sampleSize} Spielern.`);
  }

  return { sd: band.sd * factor, reasons };
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

export type DeviationClass = "im_band" | "abweichend" | "deutlich_abweichend" | "nicht_unterscheidbar";

export interface Comparison {
  featureId: FeatureId;
  band: ReferenceBand;
  /** Effective z after combining reference, measurement and cohort spread. */
  z: number | null;
  /** Probability that the true value lies on the concerning side of the band. */
  probabilityOfConcern: number | null;
  deviation: DeviationClass;
  /** Total spread used in the comparison, in the feature's unit. */
  combinedSd: number;
  cohortReasons: string[];
  /** Confidence that this comparison means anything at all. */
  confidence: number;
  /**
   * Whether this comparison could detect a one-sigma deviation at all.
   *
   * This is the guard against the most seductive failure mode of an
   * uncertainty-aware system: as the measurement gets worse, every value falls
   * comfortably inside the (now enormous) band, nothing deviates, and the score
   * goes *up*. A comparison that cannot distinguish must not contribute to a
   * verdict in either direction.
   */
  informative: boolean;
}

/**
 * Threshold on |z| beyond which a deviation is called out at all. One
 * standard deviation of a laboratory cohort is not a technical fault; it is
 * the middle two-thirds of the population.
 */
const DEVIATION_Z = 1.0;
const STRONG_DEVIATION_Z = 2.0;

/**
 * How much wider than the reference population's own spread the combined spread
 * may be before the comparison stops carrying information. At twice the
 * reference SD, a player a full standard deviation from the mean produces
 * z = 0.5 — indistinguishable from the mean itself.
 */
export const INFORMATIVE_SD_RATIO = 2.0;

export function compareToReference(
  feature: Feature,
  band: ReferenceBand,
  player: PlayerProfile,
): Comparison {
  const measure: Measure = feature.measure;
  const mismatch = cohortMismatchSd(band, player);

  if (measure.value === null || feature.rejected || measure.confidence < 0.2) {
    return {
      featureId: band.featureId,
      band,
      z: null,
      probabilityOfConcern: null,
      deviation: "nicht_unterscheidbar",
      combinedSd: band.sd,
      cohortReasons: mismatch.reasons,
      confidence: 0,
      informative: false,
    };
  }

  // The three sources of spread are independent and all real:
  //   - the reference population's own variation,
  //   - this measurement's uncertainty,
  //   - the mismatch between this player and that population.
  const combinedSd = Math.hypot(band.sd, measure.sd ?? band.sd, mismatch.sd);
  const z = (measure.value - band.mean) / combinedSd;

  // Probability that the true value lies on the side of the band that the
  // mechanism says is consequential. Two-sided only where both directions carry
  // a mechanism; "none" means the feature is descriptive and is never scored.
  let probabilityOfConcern: number | null = null;
  if (band.concernDirection === "below") probabilityOfConcern = normalCdf(z);
  else if (band.concernDirection === "above") probabilityOfConcern = 1 - normalCdf(z);
  else if (band.concernDirection === "both") probabilityOfConcern = 2 * (1 - normalCdf(Math.abs(z)));

  let deviation: DeviationClass;
  if (Math.abs(z) >= STRONG_DEVIATION_Z) deviation = "deutlich_abweichend";
  else if (Math.abs(z) >= DEVIATION_Z) deviation = "abweichend";
  else deviation = "im_band";

  // If the measurement's own spread dominates the combined spread, the
  // comparison cannot distinguish this player from the reference no matter
  // what the point estimate says.
  const measurementShare = (measure.sd ?? 0) / combinedSd;
  if (measurementShare > 0.8 && deviation === "im_band") deviation = "nicht_unterscheidbar";

  const confidence = clamp(measure.confidence * (1 - clamp(measurementShare - 0.5, 0, 0.5)), 0, 1);

  const informative =
    band.definitionMatch === "verified" && combinedSd <= INFORMATIVE_SD_RATIO * band.sd;
  if (!informative && deviation !== "deutlich_abweichend") deviation = "nicht_unterscheidbar";

  return {
    featureId: band.featureId,
    band,
    z,
    probabilityOfConcern,
    deviation,
    combinedSd,
    cohortReasons: band.definitionNote ? [band.definitionNote, ...mismatch.reasons] : mismatch.reasons,
    confidence,
    informative,
  };
}

/* ------------------------------------------------------------------ */
/* Self reference                                                      */
/* ------------------------------------------------------------------ */

export interface HistoricalSample {
  sessionId: string;
  date: string;
  featureId: FeatureId;
  value: number;
  sd: number;
}

export interface SelfComparison {
  featureId: FeatureId;
  currentValue: number;
  historyMean: number;
  historySd: number;
  sampleCount: number;
  /** Change in the feature's own units. */
  delta: number;
  /** Probability that the change is real rather than measurement noise. */
  probabilityOfRealChange: number;
  /** True when the change clears both the noise floor and a minimum size. */
  meaningful: boolean;
}

/**
 * Compares the current stroke against the player's own history.
 *
 * This is the comparison that actually drives coaching. It is also the only one
 * in which the measurement bias mostly cancels: the same pipeline, the same
 * camera class and the same body produce the same systematic error, so a
 * *change* is far better determined than an absolute value. That is why the
 * system is built to say "your contact height was more consistent than last
 * week" rather than "your contact height is 2.86 m".
 */
export function compareToSelf(
  featureId: FeatureId,
  current: Measure,
  history: HistoricalSample[],
): SelfComparison | null {
  const relevant = history.filter((h) => h.featureId === featureId);
  if (current.value === null || relevant.length < 2) return null;

  const values = relevant.map((h) => h.value);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  const historySd = Math.sqrt(variance);
  const delta = current.value - mean;

  // Standard error of the difference: this measurement's uncertainty plus the
  // standard error of the historical mean.
  const se = Math.hypot(current.sd ?? historySd, historySd / Math.sqrt(relevant.length));
  const z = se > 0 ? delta / se : 0;
  const probabilityOfRealChange = clamp(2 * normalCdf(Math.abs(z)) - 1, 0, 1);

  return {
    featureId,
    currentValue: current.value,
    historyMean: mean,
    historySd,
    sampleCount: relevant.length,
    delta,
    probabilityOfRealChange,
    // A change must be both statistically distinguishable and larger than the
    // player's own session-to-session scatter to be worth mentioning.
    meaningful: probabilityOfRealChange > 0.9 && Math.abs(delta) > 0.75 * historySd,
  };
}

export function referencesFor(stroke: string): ReferenceBand[] {
  return stroke === "serve" ? SERVE_REFERENCES : [];
}
