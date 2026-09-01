/**
 * Schritt 2 — Vom Bild zum Körper.
 *
 * Hier steckt das einzige gelernte Modell der ganzen Kette: Googles
 * PoseLandmarker findet in einem Bild eine Person und gibt 33 Punkte zurück —
 * Nase, Schultern, Ellbogen, Handgelenke, Hüften, Knie, Knöchel, Füße.
 *
 * Es liefert die Punkte doppelt, und der Unterschied ist wichtig genug, um ihn
 * zu benennen:
 *
 *   `landmarks`       — wo der Punkt **im Bild** liegt, als Anteil von Breite
 *                       und Höhe. Damit wird das Skelett über das Video
 *                       gezeichnet, und für nichts sonst.
 *
 *   `worldLandmarks`  — wo der Punkt **im Raum** liegt, in Metern, relativ zur
 *                       Hüftmitte. Das ist eine echte 3D-Schätzung, und nur
 *                       damit lassen sich Gelenkwinkel rechnen, die nicht von
 *                       der Kameraposition abhängen (siehe Schritt 4).
 *
 * Das Modell läuft im Browser, auf der Grafikkarte, und das Video wird nirgends
 * hochgeladen. Das ist kein Datenschutz-Feature, das man nachrüsten könnte —
 * es ist die Architektur.
 *
 * Zwei Betriebsarten hat der Landmarker; MOTUS benutzt VIDEO. Darin merkt sich
 * das Modell die vorherige Pose und sucht die nächste in ihrer Nähe, was
 * ruhiger läuft als eine unabhängige Suche pro Bild. Bedingung: Die Zeitstempel
 * müssen streng steigen. Weil Schritt 1 der Reihe nach vorwärts spult, ist das
 * erfüllt — aber es ist eine Bedingung, die man einmal verletzt und dann eine
 * Stunde sucht, deshalb steht sie hier.
 */

import { walkFrames } from "./01-frames.js";

/** Die 33 Punkte in der Reihenfolge, in der MediaPipe sie liefert. */
export const LANDMARK_NAMES = [
  "nose", "eyeInnerL", "eyeL", "eyeOuterL", "eyeInnerR", "eyeR", "eyeOuterR",
  "earL", "earR", "mouthL", "mouthR",
  "shoulderL", "shoulderR", "elbowL", "elbowR", "wristL", "wristR",
  "pinkyL", "pinkyR", "indexL", "indexR", "thumbL", "thumbR",
  "hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR",
  "heelL", "heelR", "footL", "footR",
];

/** Verbindungen für die Zeichnung des Skeletts. */
export const SKELETON_EDGES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];

/**
 * Startet das Modell.
 *
 * `assets` zeigt auf die Dateien: den WebAssembly-Ordner und das Modell selbst.
 * Beides liegt lokal — MOTUS lädt zur Laufzeit nichts nach, weder Modell noch
 * Bibliothek, weil ein Werkzeug, das offline nicht startet, auf einer
 * Sportanlage regelmäßig nicht startet.
 */
export async function createPoseEngine(assets) {
  // Zwei Wege, dieselbe Bibliothek zu bekommen: als Modul geladen (die Fassung
  // mit Ordner) oder schon als Objekt übergeben (die Fassung als eine Datei,
  // in der die Bibliothek bereits im Dokument steht).
  const { FilesetResolver, PoseLandmarker } = assets.vision ?? (await import(assets.visionBundle));

  // `wasmDir` fehlt, wenn das WebAssembly bereits im Dokument liegt; dann darf
  // der Resolver nicht suchen gehen, sondern bekommt leere Pfade und findet
  // alles Nötige an den Globalen, die der Aufrufer gesetzt hat.
  const fileset = assets.wasmDir
    ? await FilesetResolver.forVisionTasks(assets.wasmDir)
    : { wasmLoaderPath: "", wasmBinaryPath: "" };

  // Pfad *oder* Puffer — beides zugleich lehnt MediaPipe ab.
  const baseOptions = { delegate: assets.delegate ?? "GPU" };
  if (assets.modelBuffer) baseOptions.modelAssetBuffer = assets.modelBuffer;
  else baseOptions.modelAssetPath = assets.modelPath;

  const landmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions,
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });

  let lastTimestamp = -1;

  return {
    /**
     * Wertet ein Bild aus. `t` ist der Zeitpunkt im Video, in Sekunden.
     * Gibt `null` zurück, wenn keine Person gefunden wurde — ausdrücklich
     * `null` und nicht die letzte bekannte Pose, damit eine Lücke in Schritt 3
     * als Lücke ankommt.
     */
    detect(image, t) {
      // Der Landmarker verlangt streng steigende Zeitstempel in Millisekunden.
      // Ein Video mit wiederholten Bildern kann denselben Zeitpunkt zweimal
      // liefern; dann wird um eine Millisekunde weitergerückt, statt den Aufruf
      // zu verlieren.
      let ms = Math.round(t * 1000);
      if (ms <= lastTimestamp) ms = lastTimestamp + 1;
      lastTimestamp = ms;

      const result = landmarker.detectForVideo(image, ms);
      const world = result.worldLandmarks?.[0];
      const image2d = result.landmarks?.[0];
      if (!world || !image2d) return null;

      return {
        t,
        // Für die Rechnung: Meter im Raum, plus die Sichtbarkeit, die das
        // Modell dem Punkt selbst zutraut.
        points: world.map((p, i) => ({
          x: p.x,
          y: p.y,
          z: p.z,
          v: visibilityOf(image2d[i]),
        })),
        // Für die Zeichnung: Anteile von Breite und Höhe des Bildes.
        image: image2d.map((p) => ({ x: p.x, y: p.y, v: visibilityOf(p) })),
      };
    },

    close() {
      landmarker.close();
    },
  };
}

/**
 * Wie sicher das Modell ist, diesen Punkt gesehen zu haben.
 *
 * MediaPipe führt zwei Zahlen: `visibility` (ist der Punkt im Bild sichtbar
 * oder verdeckt?) und `presence` (ist er überhaupt im Bildausschnitt?). Beide
 * müssen stimmen, also gilt die kleinere. Ältere Modellversionen liefern nur
 * eine davon; fehlt eine, wird sie nicht erfunden, sondern übergangen.
 */
function visibilityOf(p) {
  const values = [p?.visibility, p?.presence].filter((v) => typeof v === "number");
  return values.length ? Math.min(...values) : 1;
}

/**
 * Der Bequemlichkeits-Weg: Video rein, rohe Posen raus.
 * Bindet Schritt 1 und Schritt 2 zusammen, ohne dass der Aufrufer beide kennen
 * muss.
 */
export async function extractPoses(video, engine, options) {
  const frames = [];
  let missed = 0;

  await walkFrames(video, {
    ...options,
    onFrame: (canvas, t) => {
      const pose = engine.detect(canvas, t);
      if (pose) {
        frames.push(pose);
      } else {
        missed++;
        // Ein Bild ohne Person ist trotzdem ein Bild. Es kommt als Lücke in die
        // Reihe, damit die Zeitachse nicht stillschweigend zusammenschrumpft.
        frames.push({ t, points: new Array(33).fill(null), image: null });
      }
    },
  });

  return { frames, missed };
}
