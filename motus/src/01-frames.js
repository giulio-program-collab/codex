/**
 * Schritt 1 — Vom Video zu einzelnen Bildern.
 *
 * Das klingt trivial und ist die Stelle, an der die meisten Browser-Werkzeuge
 * still danebenliegen.
 *
 * Der bequeme Weg ist, das Video abzuspielen und in jedem Bildwechsel das
 * aktuelle Bild abzugreifen. Solange die Analyse schneller läuft als das Video,
 * geht das gut. Sobald sie es nicht tut — und ein Pose-Modell braucht pro Bild
 * gern 30 Millisekunden — überspringt der Browser Bilder, ohne das zu melden.
 * Die Auswertung hat dann Löcher an genau den Stellen, an denen am meisten
 * passiert ist, weil dort am meisten zu rechnen war. Und beim zweiten Durchlauf
 * sind es andere Löcher.
 *
 * MOTUS spult stattdessen: Es setzt `currentTime` auf einen Zeitpunkt, wartet,
 * bis der Browser meldet, dass er dort ist, und liest dann das Bild. Das ist
 * langsamer, dafür wird nichts übersprungen — und welche Zeitpunkte ausgewertet
 * werden, hängt nicht mehr davon ab, wie ausgelastet der Rechner gerade war.
 *
 * Vollständig deterministisch ist die Kette damit trotzdem nicht: Das
 * Pose-Modell rechnet auf der Grafikkarte, und dort sind Ergebnisse zwischen
 * zwei Läufen um Kleinigkeiten verschieden. Auf Winkel und Spannweiten wirkt
 * sich das kaum aus; eine Wiederholung, die knapp an der Erkennungsschwelle
 * liegt, kann zwischen zwei Läufen aber die Seite wechseln.
 *
 * Vorher wird gemessen, wie schnell das Video wirklich ist. „30 fps" in den
 * Metadaten heißt nicht, dass 30 verschiedene Bilder pro Sekunde drin sind:
 * Bildschirmaufnahmen, hochskalierte Zeitlupen und viele Handy-Exporte
 * wiederholen Bilder. Wer das nicht misst, glaubt an eine zeitliche Auflösung,
 * die das Material nicht hat.
 */

/** Wenn sich die Bildrate nicht messen lässt, wird hiermit gerechnet. */
export const FALLBACK_HZ = 30;

/** Schneller als das wird nicht ausgewertet — darüber lohnt es sich nicht. */
export const MAX_ANALYSIS_HZ = 60;

/**
 * Lädt eine Videodatei in ein `<video>`-Element.
 * Gibt das Element zurück, sobald Dauer und Maße bekannt sind.
 */
export function loadVideo(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    const url = URL.createObjectURL(file);
    video.src = url;

    const fail = () =>
      reject(
        new Error(
          "Dieses Video kann der Browser nicht abspielen. Am zuverlässigsten " +
            "funktioniert MP4 mit H.264 — das liefert jede Handykamera.",
        ),
      );
    video.addEventListener("error", fail, { once: true });
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (!video.videoWidth || !video.duration || !Number.isFinite(video.duration)) {
          fail();
          return;
        }
        video.__objectUrl = url;
        resolve(video);
      },
      { once: true },
    );
  });
}

/**
 * Misst, wie viele *verschiedene* Bilder das Video pro Sekunde wirklich zeigt.
 *
 * `requestVideoFrameCallback` meldet zu jedem tatsächlich dargestellten Bild
 * dessen Position im Video (`mediaTime`). Die Abstände zwischen diesen
 * Positionen sind die echte Bildfolge — wiederholte Bilder erzeugen einen
 * Abstand von null und fallen dabei von selbst heraus.
 *
 * Genommen wird nicht der Mittelwert der Abstände, sondern ein niedriges
 * Perzentil. Ausgelassene Bilder machen einzelne Abstände doppelt so groß; ein
 * Mittelwert wird davon nach oben gezogen und meldet eine zu niedrige Bildrate.
 * Der kleinste regelmäßig auftretende Abstand ist der richtige.
 */
export async function measureFrameRate(video, { seconds = 1.2 } = {}) {
  if (typeof video.requestVideoFrameCallback !== "function") {
    return { hz: FALLBACK_HZ, measured: false, note: "Der Browser meldet keine Bildwechsel." };
  }

  const times = [];
  await seek(video, Math.min(0.05, video.duration * 0.05));

  await new Promise((resolve) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      video.pause();
      resolve();
    };
    const onFrame = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length > 240 || (times.length > 4 && times.at(-1) - times[0] > seconds)) stop();
      else video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.play().catch(stop);
    setTimeout(stop, seconds * 3000 + 800);
  });

  const deltas = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 1e-4) deltas.push(d);
  }
  if (deltas.length < 3) {
    return { hz: FALLBACK_HZ, measured: false, note: "Zu wenige Bildwechsel gesehen." };
  }

  deltas.sort((a, b) => a - b);
  const low = deltas[Math.floor(deltas.length * 0.1)];
  const raw = 1 / low;
  const hz = snapToCommonRate(raw);

  // Wie viele der dargestellten Bilder überhaupt neu waren: Bei einer
  // Bildschirmaufnahme mit 60 fps, die eine 15-fps-Quelle zeigt, ist das ein
  // Viertel — und die zeitliche Auflösung ist 15 Hz, nicht 60.
  const distinct = deltas.length / Math.max(1, times.length - 1);

  return {
    hz,
    rawHz: raw,
    measured: true,
    distinctShare: distinct,
    note:
      distinct < 0.75
        ? `Nur ${Math.round(distinct * 100)} % der Bilder sind neu — das Video wiederholt Bilder. ` +
          `Zeitlich aufgelöst sind ${hz.toFixed(0)} Hz, nicht mehr.`
        : null,
  };
}

/** Übliche Bildraten, auf die eine Messung eingerastet wird. */
const COMMON = [8, 10, 12, 15, 20, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 120, 240];

function snapToCommonRate(hz) {
  let best = hz;
  let bestErr = Infinity;
  for (const c of COMMON) {
    const err = Math.abs(c - hz) / c;
    if (err < 0.06 && err < bestErr) {
      best = c;
      bestErr = err;
    }
  }
  return best;
}

/** Setzt die Abspielposition und wartet, bis der Browser wirklich dort ist. */
export function seek(video, t) {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(video.duration - 1e-3, t));
    if (Math.abs(video.currentTime - target) < 1e-6 && video.readyState >= 2) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish);
    // Ein Sicherheitsnetz: Manche Browser melden bei einem Sprung ans Ende
    // eines Videos kein `seeked`, und dann bliebe die ganze Auswertung hängen.
    setTimeout(finish, 2000);
    video.currentTime = target;
  });
}

/**
 * Geht das Video Bild für Bild durch und ruft für jedes `onFrame(canvas, t, i)`.
 *
 * Die Bilder werden auf `maxWidth` verkleinert, bevor sie weitergereicht
 * werden. Das Pose-Modell arbeitet intern ohnehin auf 256 Pixeln; ihm ein
 * 4K-Bild zu geben kostet Zeit und bringt nichts.
 */
export async function walkFrames(video, options) {
  const {
    hz = FALLBACK_HZ,
    from = 0,
    to = video.duration,
    maxWidth = 640,
    onFrame,
    onProgress,
    signal,
  } = options;

  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const step = 1 / hz;
  const count = Math.max(1, Math.floor((to - from) / step));

  for (let i = 0; i < count; i++) {
    if (signal?.aborted) break;
    const t = from + i * step;
    await seek(video, t);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Der wirklich erreichte Zeitpunkt, nicht der gewünschte: Bei einem Video
    // mit ungleichmäßigen Abständen springt der Browser auf das nächstgelegene
    // Bild, und das ist der Zeitpunkt, zu dem dieses Bild gehört.
    await onFrame(canvas, video.currentTime, i);
    onProgress?.((i + 1) / count, i + 1, count);
  }

  return { canvas, count };
}

/** Gibt den Objekt-URL wieder frei. */
export function releaseVideo(video) {
  if (video?.__objectUrl) URL.revokeObjectURL(video.__objectUrl);
}
