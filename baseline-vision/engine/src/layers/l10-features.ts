import {
  Rng,
  type Vec3,
  angle3,
  butterworthLowPass,
  clamp,
  cross3,
  derivative,
  dot3,
  mean,
  median,
  refinedPeak,
  signedAngleAround,
  smooth,
  sub3,
  unit3,
  v3,
} from "../core/math.ts";
import { inPlaneFraction, type PinholeCamera } from "../core/camera.ts";
import {
  dominantSide,
  otherSide,
  sided,
  type Handedness,
  type Joint,
  type LayerReport,
  type Measure,
  type Pose3D,
  type StrokeType,
} from "../core/types.ts";
import { NOT_MEASURED } from "../core/types.ts";
import { measureFrom, propagateSequenceClassified } from "../core/uncertainty.ts";
import type { SegmentationResult } from "./l09-segmentation.ts";
import type { RacketResult } from "./l07-racket.ts";

/**
 * Layer 10 — Biomechanical feature extraction.
 *
 * Every feature here is a function of the *whole* reconstructed sequence, is
 * evaluated on Monte-Carlo replicas of it, and comes back as a `Measure` with
 * an uncertainty and an observability class. Nothing is read off a single
 * frame, and nothing is compared to anything yet: comparison is layer 11's job.
 *
 * The separation matters. A system that computes and judges in the same step
 * has no way to answer the question "is the measurement wrong, or is the player
 * doing something unusual?" — which is precisely the question the Sinner case
 * turns on.
 */

export type FeatureId =
  | "kneeFlexionPeak"
  | "trunkTiltAtTrophy"
  | "hipShoulderSeparationPeak"
  | "shoulderElevationAtContact"
  | "elbowFlexionAtContact"
  | "contactHeightRatio"
  | "contactHeightM"
  | "contactAheadOfFrontFoot"
  | "pelvisPeakAngularVelocity"
  | "trunkPeakAngularVelocity"
  | "pelvisPeakLead"
  | "trunkPeakLead"
  | "sequenceMargin"
  | "legDriveRise"
  | "landingLateralShift"
  | "racketHeadPeakSpeed";

export interface Feature {
  id: FeatureId;
  label: string;
  measure: Measure;
  /** Phase the feature belongs to, for the dashboard timeline. */
  phase: string;
  /** Why a coach should care; shown next to the number, never instead of it. */
  rationale: string;
  /**
   * Set when the measurement fell outside the physiologically possible range.
   * The number is kept — a developer needs to see it — but its confidence is
   * zero and layer 13 turns it into a pipeline fault rather than a finding.
   */
  rejected?: { reason: string; range: [number, number] };
}

export interface FeatureResult {
  report: LayerReport;
  features: Feature[];
  byId: Partial<Record<FeatureId, Feature>>;
}

export interface FeatureOptions {
  stroke: StrokeType;
  hand: Handedness;
  heightM: number;
  dtScene: number;
  camera: PinholeCamera;
  segmentation: SegmentationResult;
  racket: RacketResult;
  /** Confidence that rotation signs are not mirrored (from layer 6). */
  mirrorConfidence: number;
  /** Confidence in the "toward the target" axis (from layer 6). */
  targetDirConfidence: number;
  verticalConfidence: number;
  /** Common-mode relative scale uncertainty of the reconstruction, from layer 6. */
  scaleRelSd: number;
  /** Per-joint coverage after cleaning, from layer 5. */
  coverage: Partial<Record<Joint, number>>;
  /**
   * Quality of the layers this measurement rests on (pose, tracking, 3D).
   *
   * No measurement can be more trustworthy than the reconstruction it was read
   * off. Without this, a metric computed from a 30 fps clip full of rejected
   * samples inherits only its own local trust factors — joint coverage, phase
   * confidence — and those can all look excellent while the thing being
   * measured is noise.
   */
  upstreamQuality: number;
  seed?: number;
}

/**
 * Residual systematic error of the method, per feature, in the feature's own
 * unit — a Type B uncertainty in the sense of the GUM.
 *
 * These numbers are measured, not guessed: each is the bias observed across
 * repeated synthetic captures of a motion whose true value is known, rounded
 * up. They are the honest answer to "how far can this be off even when nothing
 * is noisy", and they are added in quadrature to the Monte-Carlo spread so that
 * a stated interval covers the method's own error as well as the data's.
 *
 * They are derived from the synthetic validation suite and are therefore a
 * lower bound on the real thing. Before this system is trusted on a court they
 * have to be re-derived against marker-based motion-capture ground truth on
 * real players — a synthetic fixture cannot show a bias that comes from how
 * real pose estimators fail.
 */
const METHOD_BIAS: Partial<Record<FeatureId, number>> = {
  kneeFlexionPeak: 3,
  trunkTiltAtTrophy: 3,
  hipShoulderSeparationPeak: 9,
  shoulderElevationAtContact: 12,
  elbowFlexionAtContact: 8,
  pelvisPeakLead: 0.012,
  trunkPeakLead: 0.012,
  sequenceMargin: 0.015,
  contactHeightRatio: 0.03,
  contactHeightM: 0.05,
  legDriveRise: 0.03,
  landingLateralShift: 0.02,
  racketHeadPeakSpeed: 8,
  pelvisPeakAngularVelocity: 40,
  trunkPeakAngularVelocity: 40,
  contactAheadOfFrontFoot: 0.03,
};

const MC_SEQUENCE_SAMPLES = 48;

/**
 * Low-pass cutoff for trunk and pelvis rotation before differentiation, in Hz.
 * Peak segment rotation in a serve is a smooth event lasting 80-120 ms, well
 * inside this band; everything faster is reconstruction noise.
 */
export const ROTATION_CUTOFF_HZ = 8;

/** The four joints every rotation metric reads. */
const GIRDLE_JOINTS: readonly Joint[] = ["hipL", "hipR", "shoulderL", "shoulderR"];

export function extractFeatures(poses: Pose3D[], opts: FeatureOptions): FeatureResult {
  const rng = new Rng(opts.seed ?? 1312);
  const seg = opts.segmentation;
  const side = dominantSide(opts.hand);
  const off = otherSide(side);
  const dt = opts.dtScene;
  const features: Feature[] = [];
  const notes: string[] = [];

  const contact = seg.contactFrame;

  /**
   * The contact instant, redrawn for each Monte-Carlo replica.
   *
   * Contact is not a known time, it is an estimate with its own spread, and
   * every quantity read off "the contact frame" inherits that spread. Sampling
   * it alongside the joint positions is what makes a contact-height interval
   * mean what it says: without it the reported uncertainty came out around one
   * centimetre while the true error was twelve, because a single frame of
   * contact error moves the racket head that far.
   */
  const drawContact = (): number =>
    contact === null ? 0 : contact + rng.gauss(0, seg.contactFrameSd);
  const trophy = seg.events.maxKneeFlexion ?? null;

  const cov = (j: Joint) => clamp(opts.coverage[j] ?? 0, 0, 1);
  const covOf = (...js: Joint[]) => Math.min(...js.map(cov));

  // How well the two girdle axes are seen. This is the gate that decides
  // whether rotation may be discussed at all, and it is the single most
  // important honesty check in the whole feature layer: a hip line pointing at
  // the lens projects to almost nothing, its azimuth is undefined, and any
  // rotation velocity computed from it is a measurement of noise. From a
  // side-on camera that is exactly the situation at contact in a serve.
  const rotationWindow: [number, number] =
    contact === null ? [0, poses.length - 1] : [Math.max(0, contact - 0.45 / dt), contact];
  const pelvisMask = girdleVisibility(poses, opts.camera, "hipL", "hipR");
  const trunkMask = girdleVisibility(poses, opts.camera, "shoulderL", "shoulderR");
  const rotationMask = pelvisMask.map((v, i) => Math.min(v, trunkMask[i]));
  const rotationWindowLo = Math.max(0, Math.floor(rotationWindow[0]));
  const rotationWindowHi = Math.min(poses.length - 1, Math.ceil(rotationWindow[1]));
  const observableFrames: number[] = [];
  for (let i = rotationWindowLo; i <= rotationWindowHi; i++) {
    if (rotationMask[i] >= GIRDLE_OBSERVABLE_MIN) observableFrames.push(i);
  }
  // Two things must both hold for a rotation to be reportable: the axis has to
  // be visible for enough of the phase, *and* it has to be visible well enough
  // when it is. A hip line seen at 35 % of its true width for the whole window
  // passes a coverage test and still cannot resolve an azimuth.
  const observedCoverage = clamp(
    observableFrames.length / Math.max(1, rotationWindowHi - rotationWindowLo + 1),
    0,
    1,
  );
  const observedSharpness = observableFrames.length
    ? clamp(median(observableFrames.map((i) => rotationMask[i])) ?? 0, 0, 1)
    : 0;
  const rotationView = Math.min(observedCoverage, observedSharpness);
  // The search for a rotation peak is confined to the frames in which the axis
  // is actually visible. Outside them the azimuth is not a noisy measurement,
  // it is not a measurement at all, and its derivative reaches thousands of
  // degrees per second purely from the sign of an undetermined depth flipping.
  const searchLo = observableFrames.length ? observableFrames[0] : 0;
  const searchHi = observableFrames.length ? observableFrames[observableFrames.length - 1] : 0;
  if (rotationView < GIRDLE_OBSERVABLE_MIN) {
    notes.push(
      `Die Körperachsen zeigen in der relevanten Phase nahezu auf die Kamera ` +
        `(Sichtbarkeit ${Math.round(rotationView * 100)} %). Rotationsgrößen werden nicht ausgegeben.`,
    );
  }
  const rotationTrust = { label: "Sichtbarkeit der Körperachsen", value: rotationView };
  const rotationUnmeasurable =
    observableFrames.length < 6 || rotationView < ROTATION_OBSERVABLE_COVERAGE_MIN;
  const rotationNote =
    `Die Hüft- bzw. Schulterachse liegt in der Beschleunigungsphase fast parallel zur Blickrichtung ` +
    `der Kamera. Ihre Ausrichtung um die Längsachse ist damit aus diesem Video nicht bestimmbar — ` +
    `unabhängig davon, wie gut die Gelenke erkannt wurden.`;

  const add = (
    id: FeatureId,
    label: string,
    phase: string,
    rationale: string,
    compute: (ps: Pose3D[]) => number | null,
    unit: string,
    trust: Array<{ label: string; value: number }>,
    /** Joints the metric reads; only these are perturbed. */
    reads: readonly Joint[],
    notesForMeasure?: string[],
  ) => {
    const { mc, observability, depthRatio } = propagateSequenceClassified(
      poses,
      opts.camera,
      compute,
      rng,
      MC_SEQUENCE_SAMPLES,
      reads,
    );
    const extra = [...(notesForMeasure ?? [])];
    if (depthRatio !== null && depthRatio > 2.5) {
      extra.push(
        `Die Unsicherheit dieser Größe wird um den Faktor ${depthRatio.toFixed(1)} von der ` +
          "Tiefenrichtung bestimmt — aus dieser Kameraperspektive nur eingeschränkt bestimmbar.",
      );
    }
    // The reconstruction's overall scale error is common to every joint, so it
    // cancels in angles and in ratios taken against the player's own
    // dimensions, and acts in full on absolute lengths. Adding it per joint
    // upstream would corrupt the shape; adding it here, to the metrics it
    // actually affects, is where it belongs.
    const scaled =
      unit === "m" && mc.value !== null && mc.sd !== null
        ? { ...mc, sd: Math.hypot(mc.sd, Math.abs(mc.value) * opts.scaleRelSd) }
        : mc;
    // Type B uncertainty: the method's own residual systematic error.
    //
    // The Monte-Carlo term above answers "how much would this number move if
    // the joints were somewhere else within their covariance". It cannot see a
    // bias — an error the method makes the same way every time — and the
    // validation suite shows several: shoulder elevation at contact reads about
    // ten degrees high, hip-shoulder separation about eight degrees low. An
    // interval that ignores a known bias is not conservative, it is wrong.
    const bias = METHOD_BIAS[id];
    const budgeted =
      bias !== undefined && scaled.value !== null && scaled.sd !== null
        ? { ...scaled, sd: Math.hypot(scaled.sd, bias) }
        : scaled;
    const measure = measureFrom(budgeted, {
      unit,
      observability,
      provenance: ["L6", "L9", "L10"],
      trust: [...trust, { label: "Güte der Rekonstruktion", value: opts.upstreamQuality }],
      notes: [
        ...extra,
        ...(unit === "m"
          ? [
              `Enthält die gemeinsame Skalenunsicherheit der Rekonstruktion von ` +
                `${(opts.scaleRelSd * 100).toFixed(0)} %. Bei Winkeln und Verhältniswerten entfällt sie.`,
            ]
          : []),
      ],
      sdFloor: sdFloorFor(unit, dt),
    });
    const feature: Feature = { id, label, measure, phase, rationale };
    const range = PLAUSIBLE_RANGE[id];
    if (measure.value !== null && range && (measure.value < range[0] || measure.value > range[1])) {
      // A value outside the physiologically possible range is not an unusual
      // athlete. It is a broken measurement, and reporting it as a finding —
      // however carefully hedged — would be worse than reporting nothing.
      feature.rejected = {
        reason:
          `Gemessen: ${measure.value.toFixed(1)} ${unit}. Physiologisch möglich sind ` +
          `${range[0]}–${range[1]} ${unit}. Die Messung wird verworfen.`,
        range,
      };
      feature.measure = {
        ...measure,
        confidence: 0,
        notes: [...measure.notes, feature.rejected.reason],
      };
    }
    features.push(feature);
  };

  /* ---------------- Loading phase ---------------- */

  if (trophy !== null) {
    add(
      "kneeFlexionPeak",
      "Maximale Knieflexion (vorderes Bein)",
      "Ladephase",
      "Der Beinantrieb ist der Anfang der kinetischen Kette. Eine tiefere Ladung senkt zugleich die " +
        "Belastung von Schulter und Ellbogen.",
      (ps) => {
        const series = ps.map((p) => {
          const hip = p[sided("hip", off)];
          const knee = p[sided("knee", off)];
          const ankle = p[sided("ankle", off)];
          if (!hip || !knee || !ankle) return null;
          const a = angle3(hip.p, knee.p, ankle.p);
          return a === null ? null : 180 - a;
        });
        return robustPeak(series, PLAUSIBLE_RANGE.kneeFlexionPeak, 1 / dt);
      },
      "°",
      [
        { label: "Gelenkabdeckung Bein", value: covOf(sided("hip", off), sided("knee", off), sided("ankle", off)) },
        // The peak is taken over the whole clip, so it depends on the loading
        // *event* being identifiable, not on where the phase boundaries were
        // drawn around it.
        { label: "Erkennbarkeit der Ladephase", value: trophy !== null ? 0.9 : 0.4 },
      ],
      [sided("hip", off), sided("knee", off), sided("ankle", off)],
    );

    add(
      "trunkTiltAtTrophy",
      "Rumpfneigung in der Trophy-Position",
      "Ladephase",
      "Zeigt, ob sich der Spieler vor dem Beinantrieb überhaupt in Bogenspannung bringt.",
      (ps) => {
        const p = interpolatePose(ps, trophy);
        if (!p) return null;
        const pelvis = p.pelvis;
        const sternum = p.sternum ?? p.neck;
        if (!pelvis || !sternum) return null;
        const trunk = sub3(sternum.p, pelvis.p);
        const vertical = v3(0, 0, 1);
        const a = angleBetweenSafe(trunk, vertical);
        return a;
      },
      "°",
      [
        { label: "Gelenkabdeckung Rumpf", value: covOf("pelvis", "sternum") },
        { label: "Vertikalbestimmung", value: opts.verticalConfidence },
      ],
      ["pelvis", "sternum", "neck"],
    );
  } else {
    notes.push("Trophy-Position nicht bestimmbar — Ladephasen-Größen entfallen.");
  }

  /* ---------------- Rotation and sequencing ---------------- */

  const pelvisYaw = (p: Pose3D): number | null => {
    const l = p.hipL;
    const r = p.hipR;
    if (!l || !r) return null;
    return signedAngleAround(sub3(r.p, l.p), v3(1, 0, 0), v3(0, 0, 1));
  };
  const trunkYaw = (p: Pose3D): number | null => {
    const l = p.shoulderL;
    const r = p.shoulderR;
    if (!l || !r) return null;
    return signedAngleAround(sub3(r.p, l.p), v3(1, 0, 0), v3(0, 0, 1));
  };

  const addRotation = (
    id: FeatureId,
    label: string,
    phase: string,
    rationale: string,
    compute: (ps: Pose3D[]) => number | null,
    unit: string,
    trust: Array<{ label: string; value: number }>,
    _reads?: readonly Joint[],
  ) => {
    if (rotationUnmeasurable) {
      features.push({
        id,
        label,
        phase,
        rationale,
        measure: NOT_MEASURED(unit, "unobservable", ["L6", "L10"], rotationNote),
      });
      return;
    }
    add(id, label, phase, rationale, compute, unit, [...trust, rotationTrust], GIRDLE_JOINTS);
  };

  addRotation(
    "hipShoulderSeparationPeak",
    "Maximale Schulter-Hüft-Trennung",
    "Ladephase",
    "Die Trennung speichert die elastische Energie, die der Rumpf anschließend freisetzt. Sie ist der " +
      "am häufigsten unterschätzte Unterschied zwischen einem Aufschlag mit und ohne Peitscheneffekt.",
    (ps) => {
      const sep = ps.map((p) => {
        const a = pelvisYaw(p);
        const b = trunkYaw(p);
        return a === null || b === null ? null : unwrapDelta(b - a);
      });
      return robustPeak(
        sep.slice(searchLo, searchHi + 1),
        PLAUSIBLE_RANGE.hipShoulderSeparationPeak,
        1 / dt,
      );
    },
    "°",
    [
      { label: "Gelenkabdeckung Hüfte/Schulter", value: covOf("hipL", "hipR", "shoulderL", "shoulderR") },
      // The magnitude of the separation survives a mirrored reconstruction; its
      // sign does not, so the mirror confidence enters at reduced weight.
      { label: "Tiefenrichtung", value: 0.4 + 0.6 * opts.mirrorConfidence },
    ],
    GIRDLE_JOINTS,
  );

  /**
   * Angle series ready to be differentiated.
   *
   * The low-pass is the whole reason the angular velocities are usable at all.
   * Differentiating a reconstructed angle multiplies its noise by the sampling
   * rate: at 120 Hz, one degree of frame-to-frame jitter on the hip line — a
   * centimetre of depth error on a 36 cm baseline — becomes 120 deg/s of pure
   * noise, and the peak of a noisy signal is a measurement of the noise.
   */
  const yawSeries = (ps: Pose3D[], f: (p: Pose3D) => number | null): number[] =>
    butterworthLowPass(unwrapSeries(ps.map(f)), ROTATION_CUTOFF_HZ, 1 / dt);

  for (const [id, label, fn] of [
    ["pelvisPeakAngularVelocity", "Maximale Beckenrotationsgeschwindigkeit", pelvisYaw],
    ["trunkPeakAngularVelocity", "Maximale Rumpfrotationsgeschwindigkeit", trunkYaw],
  ] as Array<[FeatureId, string, (p: Pose3D) => number | null]>) {
    addRotation(
      id,
      label,
      "Beschleunigung",
      "Rotationsgeschwindigkeiten sind der eigentliche Output der kinetischen Kette; Winkel allein sagen " +
        "nichts darüber aus, wie schnell die gespeicherte Energie freigesetzt wird.",
      (ps) => {
        const w = derivative(yawSeries(ps, fn), dt).map(Math.abs);
        const pk = refinedPeak(w.slice(searchLo, searchHi + 1));
        return pk ? pk.value : null;
      },
      "°/s",
      [
        { label: "Gelenkabdeckung", value: covOf("hipL", "hipR", "shoulderL", "shoulderR") },
        { label: "Zeitauflösung", value: clamp(dt <= 1 / 120 ? 1 : dt <= 1 / 60 ? 0.7 : 0.3, 0, 1) },
      ],
      GIRDLE_JOINTS,
    );
  }

  if (contact !== null) {
    for (const [id, label, fn] of [
      ["pelvisPeakLead", "Becken-Peak vor Treffpunkt", pelvisYaw],
      ["trunkPeakLead", "Rumpf-Peak vor Treffpunkt", trunkYaw],
    ] as Array<[FeatureId, string, (p: Pose3D) => number | null]>) {
      addRotation(
        id,
        label,
        "Beschleunigung",
        "Weltklasse-Spieler drehen später maximal auf: die Rotation wirkt näher am Treffpunkt. Die " +
          "Reihenfolge Becken vor Rumpf muss dabei erhalten bleiben.",
        (ps) => {
          const w = derivative(yawSeries(ps, fn), dt).map(Math.abs);
          const pk = refinedPeak(w.slice(searchLo, searchHi + 1));
          return pk ? (pk.index + searchLo - contact) * dt : null;
        },
        "s",
        [
          { label: "Gelenkabdeckung", value: covOf("hipL", "hipR", "shoulderL", "shoulderR") },
          { label: "Treffpunktbestimmung", value: seg.contactConfidence },
          { label: "Zeitauflösung", value: clamp(dt <= 1 / 120 ? 1 : dt <= 1 / 60 ? 0.6 : 0.15, 0, 1) },
        ],
        GIRDLE_JOINTS,
      );
    }

    addRotation(
      "sequenceMargin",
      "Abstand Becken-Peak zu Rumpf-Peak",
      "Beschleunigung",
      "Positiv bedeutet: das Becken erreicht sein Maximum vor dem Rumpf — die proximal-distale " +
        "Sequenz ist intakt. Kehrt sie sich um, ist jede Diskussion über Timing-Feinheiten verfrüht.",
      (ps) => {
        const wp = derivative(yawSeries(ps, pelvisYaw), dt).map(Math.abs);
        const wt = derivative(yawSeries(ps, trunkYaw), dt).map(Math.abs);
        const a = refinedPeak(wp.slice(searchLo, searchHi + 1));
        const b = refinedPeak(wt.slice(searchLo, searchHi + 1));
        return a && b ? (b.index - a.index) * dt : null;
      },
      "s",
      [
        { label: "Gelenkabdeckung", value: covOf("hipL", "hipR", "shoulderL", "shoulderR") },
        { label: "Zeitauflösung", value: clamp(dt <= 1 / 120 ? 1 : dt <= 1 / 60 ? 0.6 : 0.15, 0, 1) },
      ],
      GIRDLE_JOINTS,
    );

    /* ---------------- Contact ---------------- */

    add(
      "shoulderElevationAtContact",
      "Schulterelevation im Treffpunkt",
      "Treffpunkt",
      "Zu tiefe Elevation kostet Treffpunkthöhe und erhöht die Schulterlast.",
      (ps) => {
        const p = interpolatePose(ps, drawContact());
        if (!p) return null;
        const sh = p[sided("shoulder", side)];
        const el = p[sided("elbow", side)];
        const pelvis = p.pelvis;
        const sternum = p.sternum ?? p.neck;
        if (!sh || !el || !pelvis || !sternum) return null;
        const trunk = sub3(sternum.p, pelvis.p);
        const humerus = sub3(el.p, sh.p);
        const a = angleBetweenSafe(trunk, humerus);
        return a === null ? null : 180 - a;
      },
      "°",
      [
        { label: "Gelenkabdeckung Schlagarm", value: covOf(sided("shoulder", side), sided("elbow", side)) },
        { label: "Treffpunktbestimmung", value: seg.contactConfidence },
      ],
      [sided("shoulder", side), sided("elbow", side), "pelvis", "sternum", "neck"],
    );

    add(
      "elbowFlexionAtContact",
      "Ellbogenflexion im Treffpunkt",
      "Treffpunkt",
      "Ein zu stark gebeugter Arm im Treffpunkt bricht die Beschleunigungskette; ein völlig " +
        "durchgestreckter kostet Kontrolle. Beides ist nur im Zusammenhang mit dem Timing zu bewerten.",
      (ps) => {
        const p = interpolatePose(ps, drawContact());
        if (!p) return null;
        const sh = p[sided("shoulder", side)];
        const el = p[sided("elbow", side)];
        const wr = p[sided("wrist", side)];
        if (!sh || !el || !wr) return null;
        const a = angle3(sh.p, el.p, wr.p);
        return a === null ? null : 180 - a;
      },
      "°",
      [
        {
          label: "Gelenkabdeckung Schlagarm",
          value: covOf(sided("shoulder", side), sided("elbow", side), sided("wrist", side)),
        },
        { label: "Treffpunktbestimmung", value: seg.contactConfidence },
      ],
      [sided("shoulder", side), sided("elbow", side), sided("wrist", side)],
    );

    const racketHeadAt = (frame: number): Vec3 | null => {
      const last = opts.racket.frames.length - 1;
      if (last < 0) return null;
      const f = clamp(frame, 0, last);
      const lo = Math.floor(f);
      const hi = Math.min(lo + 1, last);
      const a = opts.racket.frames[lo]?.head;
      const b = opts.racket.frames[hi]?.head;
      if (!a || !b) return a ?? b ?? null;
      const u = f - lo;
      return v3(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
    };

    const head = racketHeadAt(contact);
    /**
     * The racket head for one Monte-Carlo replica.
     *
     * Two independent errors act on it and both have to be carried. The
     * *timing* error moves along the racket's own path — at 30 m/s through
     * contact, one frame at 240 fps is 13 cm — and is captured by evaluating
     * the tracked path at the redrawn contact instant. The *reconstruction*
     * error moves the whole arm, and is captured by carrying the perturbation
     * of the hand, which is the skeleton joint the racket is anchored to.
     *
     * Perturbing only the skeleton, as an earlier version did, reported about
     * a centimetre of uncertainty on a measurement whose true error was twelve.
     */
    const handAt = (ps: Pose3D[], frame: number): Vec3 | null =>
      interpolatePose(ps, frame)?.[sided("hand", side)]?.p ?? null;

    const headFrom = (ps: Pose3D[]): Vec3 | null => {
      const frame = drawContact();
      const path = racketHeadAt(frame);
      if (!path) return null;
      const nominalHand = handAt(poses, frame);
      const replicaHand = handAt(ps, frame);
      if (!nominalHand || !replicaHand) return path;
      return v3(
        path.x + (replicaHand.x - nominalHand.x),
        path.y + (replicaHand.y - nominalHand.y),
        path.z + (replicaHand.z - nominalHand.z),
      );
    };

    if (head) {
      // Contact height as a ratio of standing height is far more robust than
      // the absolute value: the dominant error is the overall depth scale, and
      // it divides out.
      add(
        "contactHeightRatio",
        "Treffpunkthöhe (Vielfaches der Körperhöhe)",
        "Treffpunkt",
        "Bei Junioren korreliert die Treffpunkthöhe stark mit der Aufschlaggeschwindigkeit. Als " +
          "Verhältnis zur Körperhöhe ist sie weitgehend unabhängig von der Kalibrierung.",
        (ps) => {
          const h = headFrom(ps);
          return h ? h.z / opts.heightM : null;
        },
        "× Körperhöhe",
        [
          { label: "Schlägererkennung", value: clamp(opts.racket.coverage, 0, 1) },
          { label: "Treffpunktbestimmung", value: seg.contactConfidence },
          { label: "Vertikalbestimmung", value: opts.verticalConfidence },
        ],
        [sided("hand", side)],
      );

      add(
        "contactHeightM",
        "Treffpunkthöhe (absolut)",
        "Treffpunkt",
        "Absolute Höhen hängen direkt an der Brennweite und der Distanzschätzung. Ohne Platzkalibrierung " +
          "ist die Unsicherheit hier deutlich größer als beim Verhältniswert.",
        (ps) => {
          const h = headFrom(ps);
          return h ? h.z : null;
        },
        "m",
        [
          { label: "Schlägererkennung", value: clamp(opts.racket.coverage, 0, 1) },
          { label: "Treffpunktbestimmung", value: seg.contactConfidence },
          { label: "Vertikalbestimmung", value: opts.verticalConfidence },
        ],
        [sided("hand", side)],
      );

      if (opts.targetDirConfidence >= 0.35) {
        add(
          "contactAheadOfFrontFoot",
          "Treffpunkt vor dem vorderen Fuß",
          "Treffpunkt",
          "Ein Treffpunkt vor dem Körper überträgt den Beinantrieb nach vorne statt nach oben.",
          (ps) => {
            const p = interpolatePose(ps, drawContact());
            const ankle = p?.[sided("ankle", off)];
            const h = headFrom(ps);
            if (!ankle || !h) return null;
            return (h.y - ankle.p.y) / opts.heightM;
          },
          "× Körperhöhe",
          [
            { label: "Zielrichtung", value: opts.targetDirConfidence },
            { label: "Treffpunktbestimmung", value: seg.contactConfidence },
          ],
          [sided("hand", side), sided("ankle", off)],
        );
      } else {
        features.push({
          id: "contactAheadOfFrontFoot",
          label: "Treffpunkt vor dem vorderen Fuß",
          phase: "Treffpunkt",
          rationale: "Ein Treffpunkt vor dem Körper überträgt den Beinantrieb nach vorne statt nach oben.",
          measure: NOT_MEASURED(
            "× Körperhöhe",
            "unobservable",
            ["L6", "L10"],
            "Die Zielrichtung konnte nicht sicher bestimmt werden (keine Platzlinien, kein verwertbarer " +
              "Balltrack). Ohne sie ist 'vor dem Körper' nicht definiert.",
          ),
        });
      }
    }
  }

  /* ---------------- Leg drive and landing ---------------- */

  add(
    "legDriveRise",
    "Hubhöhe des Beckens",
    "Beinantrieb",
    "Der vertikale Weg zwischen tiefster Ladung und Treffpunkt ist das direkteste Maß dafür, wie viel " +
      "der Beinantrieb tatsächlich beiträgt.",
    (ps) => {
      const raw = ps.map((p) => p.pelvis?.p.z ?? null);
      const known = raw.filter((x): x is number => x !== null);
      if (known.length < 8) return null;
      let last = known[0];
      const dense = raw.map((x) => {
        if (x !== null) last = x;
        return last;
      });
      const z = butterworthLowPass(dense, 8, 1 / dt);
      const upTo = contact === null ? z.length : Math.min(z.length, Math.floor(contact) + 1);
      const window = z.slice(0, upTo);
      if (window.length < 4) return null;
      const lowIndex = window.indexOf(Math.min(...window));
      const after = window.slice(lowIndex);
      return Math.max(...after) - window[lowIndex];
    },
    "m",
    [
      { label: "Gelenkabdeckung Becken", value: covOf("hipL", "hipR") },
      { label: "Vertikalbestimmung", value: opts.verticalConfidence },
    ],
    ["pelvis"],
  );

  if (contact !== null) {
    add(
      "landingLateralShift",
      "Seitliche Landeabweichung",
      "Landung",
      "Eine ausgeprägte seitliche Landung deutet darauf hin, dass der Antrieb nicht in Schlagrichtung " +
        "wirkte — häufig eine Folge davon, dass der Rumpf die Rotation zu früh übernimmt.",
      (ps) => {
        const at = interpolatePose(ps, drawContact());
        const landingFrame = Math.min(ps.length - 1, Math.floor(contact + 0.35 / dt));
        const later = ps[landingFrame];
        if (!at?.pelvis || !later?.pelvis) return null;
        return Math.abs(later.pelvis.p.x - at.pelvis.p.x) / opts.heightM;
      },
      "× Körperhöhe",
      [
        { label: "Gelenkabdeckung Becken", value: covOf("hipL", "hipR") },
        { label: "Zielrichtung", value: Math.max(0.3, opts.targetDirConfidence) },
      ],
      ["pelvis"],
    );
  }

  /* ---------------- Racket ---------------- */

  if (opts.racket.speedResolvable && opts.racket.peakHeadSpeedMs !== null) {
    features.push({
      id: "racketHeadPeakSpeed",
      label: "Spitzengeschwindigkeit Schlägerkopf",
      phase: "Beschleunigung",
      rationale:
        "Der Output der gesamten Kette. Aus einer Kamera nur mit hoher Bildrate seriös messbar und " +
        "selbst dann mit spürbarer Unsicherheit.",
      measure: {
        value: opts.racket.peakHeadSpeedMs * 3.6,
        sd: (opts.racket.peakHeadSpeedSd ?? opts.racket.peakHeadSpeedMs * 0.15) * 3.6,
        confidence: clamp(opts.racket.coverage * 0.8, 0, 0.8),
        unit: "km/h",
        observability: "reconstructed",
        provenance: ["L7", "L10"],
        notes: [
          "Sehnenlänge statt Bogenlänge: die Messung unterschätzt die wahre Bahngeschwindigkeit " +
            "systematisch, und zwar stärker, je niedriger die Bildrate ist.",
        ],
      },
    });
  } else {
    features.push({
      id: "racketHeadPeakSpeed",
      label: "Spitzengeschwindigkeit Schlägerkopf",
      phase: "Beschleunigung",
      rationale: "Der Output der gesamten Kette.",
      measure: NOT_MEASURED(
        "km/h",
        "unobservable",
        ["L7", "L10"],
        opts.racket.report.notes[0] ??
          "Die Bildrate reicht für eine Schlägerkopfgeschwindigkeit nicht aus.",
      ),
    });
  }

  const byId: Partial<Record<FeatureId, Feature>> = {};
  for (const f of features) byId[f.id] = f;

  const measured = features.filter((f) => f.measure.value !== null && !f.rejected);
  const rejected = features.filter((f) => f.rejected);
  for (const f of rejected) {
    notes.push(`${f.label}: ${f.rejected?.reason}`);
  }
  const quality = features.length
    ? clamp((mean(measured.map((f) => f.measure.confidence)) ?? 0) * (measured.length / features.length), 0, 1)
    : 0;

  if (measured.length < features.length) {
    notes.push(
      `${features.length - measured.length} von ${features.length} Kenngrößen konnten nicht gemessen werden.`,
    );
  }

  return {
    report: {
      id: "L10",
      name: "Biomechanische Merkmale",
      status: quality > 0.55 ? "ok" : quality > 0.25 ? "degraded" : "failed",
      quality,
      notes,
      diagnostics: {
        merkmaleGesamt: features.length,
        merkmaleGemessen: measured.length,
        mittlereSicherheit: Number((mean(measured.map((f) => f.measure.confidence)) ?? 0).toFixed(2)),
        tiefenlimitiert: features.filter((f) => f.measure.observability === "depth_limited").length,
        verworfen: rejected.length,
      },
    },
    features,
    byId,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Minimum in-plane fraction of a girdle axis for its rotation to be reportable.
 *
 * Below roughly a third, the axis projects to less than a third of its true
 * width and its azimuth error exceeds 30 degrees for a centimetre of depth
 * noise. There is no filtering that recovers information the projection never
 * contained.
 */
export const GIRDLE_OBSERVABLE_MIN = 0.34;

/**
 * Fraction of the acceleration phase in which the axes must be visible before a
 * rotation figure may be quoted at all. A peak found in the last handful of
 * usable frames is as likely to be the edge of the visible window as the real
 * maximum.
 */
export const ROTATION_OBSERVABLE_COVERAGE_MIN = 0.45;

/**
 * Median in-plane fraction of the segment between two joints over a window,
 * i.e. how much of its true length the camera actually sees.
 */
export function girdleVisibility(
  poses: Pose3D[],
  cam: PinholeCamera,
  a: Joint,
  b: Joint,
): number[] {
  return poses.map((pose) => {
    const ka = pose[a];
    const kb = pose[b];
    if (!ka || !kb) return 0;
    const d = sub3(kb.p, ka.p);
    if (Math.hypot(d.x, d.y, d.z) < 1e-6) return 0;
    return clamp(inPlaneFraction(cam, d), 0, 1);
  });
}

/**
 * Irreducible uncertainty per unit, beyond what the error model covers.
 *
 * Angles: skin-marker and landmark-definition differences between a study's
 * anatomical convention and a detector's training data are worth a couple of
 * degrees on their own. Times: an event cannot be located better than the frame
 * grid allows, and sub-frame interpolation buys some of that back but not all.
 * Lengths: the anthropometric scale itself is only an estimate.
 */
export function sdFloorFor(unit: string, dtScene: number): number {
  switch (unit) {
    case "°":
      return 2;
    case "°/s":
      return 25;
    case "s":
      return Math.max(0.4 * dtScene, 0.003);
    case "m":
      return 0.015;
    case "km/h":
      return 4;
    case "× Körperhöhe":
      return 0.012;
    default:
      return 0;
  }
}

/**
 * Physiologically possible ranges. A value outside these is not an unusual
 * athlete, it is a broken measurement, and the difference matters: the first is
 * a coaching finding, the second is a bug report. Layer 13 turns violations
 * into an explicit "measurement rejected" rather than into advice.
 */
export const PLAUSIBLE_RANGE: Record<FeatureId, [number, number]> = {
  kneeFlexionPeak: [0, 150],
  trunkTiltAtTrophy: [0, 55],
  hipShoulderSeparationPeak: [0, 72],
  shoulderElevationAtContact: [50, 185],
  elbowFlexionAtContact: [0, 120],
  contactHeightRatio: [0.85, 2.0],
  contactHeightM: [1.0, 4.2],
  contactAheadOfFrontFoot: [-0.6, 0.8],
  pelvisPeakAngularVelocity: [40, 1400],
  trunkPeakAngularVelocity: [40, 1800],
  pelvisPeakLead: [-0.45, 0.02],
  trunkPeakLead: [-0.45, 0.02],
  sequenceMargin: [-0.3, 0.3],
  legDriveRise: [0, 0.75],
  landingLateralShift: [0, 1.2],
  racketHeadPeakSpeed: [25, 260],
};

/**
 * Peak of a noisy series, taken only over physiologically possible values and
 * after low-pass filtering.
 *
 * Taking the raw maximum of a reconstructed series is a trap: the maximum is
 * precisely the sample most likely to be an artefact, so the "peak knee
 * flexion" of an unfiltered reconstruction is a measurement of its worst frame.
 */
function robustPeak(
  series: Array<number | null>,
  range: [number, number],
  sampleHz: number,
  cutoffHz = 12,
): number | null {
  const usable = series.map((v) =>
    v !== null && Number.isFinite(v) && v >= range[0] - 15 && v <= range[1] + 15 ? v : null,
  );
  const known = usable.filter((v): v is number => v !== null);
  if (known.length < Math.max(4, series.length * 0.3)) return null;
  let last = known[0];
  const dense = usable.map((v) => {
    if (v !== null) last = v;
    return last;
  });
  const filtered = butterworthLowPass(dense, cutoffHz, sampleHz);
  const pk = refinedPeak(filtered);
  return pk ? pk.value : null;
}

function angleBetweenSafe(a: Vec3, b: Vec3): number | null {
  const na = Math.hypot(a.x, a.y, a.z);
  const nb = Math.hypot(b.x, b.y, b.z);
  if (na < 1e-9 || nb < 1e-9) return null;
  return (Math.acos(clamp(dot3(a, b) / (na * nb), -1, 1)) * 180) / Math.PI;
}

/** Linear interpolation between two poses at a fractional frame index. */
export function interpolatePose(poses: Pose3D[], frame: number): Pose3D | null {
  if (poses.length === 0) return null;
  const f = clamp(frame, 0, poses.length - 1);
  const lo = Math.floor(f);
  const hi = Math.min(lo + 1, poses.length - 1);
  const u = f - lo;
  const a = poses[lo];
  const b = poses[hi];
  if (!a || !b) return a ?? b ?? null;
  const out: Pose3D = {};
  for (const key of Object.keys(a) as Joint[]) {
    const ka = a[key];
    const kb = b[key];
    if (!ka) continue;
    if (!kb) {
      out[key] = ka;
      continue;
    }
    out[key] = {
      ...ka,
      p: v3(
        ka.p.x + (kb.p.x - ka.p.x) * u,
        ka.p.y + (kb.p.y - ka.p.y) * u,
        ka.p.z + (kb.p.z - ka.p.z) * u,
      ),
    };
  }
  return out;
}

/** Removes 360-degree wraps from an angle series so derivatives stay finite. */
export function unwrapSeries(raw: Array<number | null>): number[] {
  const out: number[] = [];
  let last = 0;
  let offset = 0;
  let started = false;
  for (const v of raw) {
    if (v === null || !Number.isFinite(v)) {
      out.push(started ? last + offset : 0);
      continue;
    }
    if (started) {
      const d = v + offset - last - offset;
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    last = v;
    started = true;
    out.push(v + offset);
  }
  return out;
}

export const unwrapDelta = (d: number): number => {
  let x = d;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
};

/** Kept for the 3D view: unit vectors of the body axes at a given frame. */
export function bodyAxes(pose: Pose3D): { up: Vec3; right: Vec3; forward: Vec3 } | null {
  const pelvis = pose.pelvis;
  const sternum = pose.sternum ?? pose.neck;
  const sl = pose.shoulderL;
  const sr = pose.shoulderR;
  if (!pelvis || !sternum || !sl || !sr) return null;
  const up = unit3(sub3(sternum.p, pelvis.p));
  const right = unit3(sub3(sr.p, sl.p));
  const forward = unit3(cross3(up, right));
  return { up, right: unit3(cross3(forward, up)), forward };
}

