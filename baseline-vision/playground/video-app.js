/* eslint-env browser */
/**
 * Video in, report out.
 *
 * The measurement chain still starts at joint positions — that has not changed
 * and should not. What changed is who produces them: this file runs a pose
 * estimator over the frames of a video file in the browser, assembles the clip
 * the engine expects, and hands it to the same `runClip` the file-drop route
 * uses. Everything downstream is identical, which is the point: there is one
 * measurement path, and the video route is a front end for it rather than a
 * second, differently-behaving product.
 *
 * Two things this cannot do for you, both stated in the interface rather than
 * hidden: it cannot see the instant of ball-racket contact, and it cannot know
 * the camera's focal length.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /** Moves the little step rail at the top of the panel. */
  function step(active) {
    const items = document.querySelectorAll("#steps li");
    items.forEach((li) => {
      const n = Number(li.dataset.step);
      li.dataset.state = n < active ? "done" : n === active ? "active" : "";
    });
  }

  /**
   * Monotonic timestamps for the estimator.
   *
   * MediaPipe's video mode rejects a timestamp that is not greater than the
   * last one, and it has no way to know that the coarse search and the fine
   * pass are two sweeps over the same clip. A counter that only ever goes up
   * keeps both sweeps legal.
   */
  let clock = 0;
  const nextTimestamp = () => (clock += 33);

  function progress(fraction) {
    const bar = $("v-progress");
    bar.hidden = fraction === null;
    if (fraction !== null) bar.firstElementChild.style.width = Math.round(fraction * 100) + "%";
  }
  const VENDOR = "./vendor/";

  /** MediaPipe's 33 landmarks, in its own order — the clip loader knows it. */
  const LAYOUT = "mediapipe33";

  const state = {
    file: null,
    video: null,
    /** Extracted frames: {t, keypoints, depth} plus the image for the marker view. */
    frames: [],
    thumbnails: [],
    contactFrame: null,
    fps: 30,
    width: 0,
    height: 0,
    landmarker: null,
  };

  /* ---------------------------------------------------------------- */
  /* Loading the estimator                                             */
  /* ---------------------------------------------------------------- */

  let visionModule = null;
  let inlineWasm = null;
  let inlineModel = null;

  /** True when the page carries the estimator inside itself. */
  const inlined = () => Boolean(window.__BV_ASSETS);

  /**
   * Unpacks an asset that was embedded in the page.
   *
   * The runtime and the model are fifteen megabytes, which is more than a
   * single HTML file may weigh. Gzipped and base64-encoded they are ten, which
   * is not, and the browser can undo both in about a tenth of a second. This is
   * what lets the published page analyse a video without fetching anything —
   * which matters because it may not fetch anything.
   */
  async function inflate(base64) {
    const binary = atob(base64);
    const packed = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) packed[i] = binary.charCodeAt(i);
    if (typeof DecompressionStream !== "function") {
      throw new Error(
        "Dieser Browser kann die eingebetteten Daten nicht entpacken (DecompressionStream fehlt). " +
          "Chrome, Edge, Firefox ab 113 oder Safari ab 16.4 können es.",
      );
    }
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function loadLandmarker(modelFile) {
    const status = (text) => ($("v-status").textContent = text);

    if (inlined()) {
      // Everything is already in the page: the bundle ran as a plain script and
      // left its exports on a global, and the two binaries only have to be
      // unpacked once.
      visionModule = window.__mpVision;
      if (!visionModule) throw new Error("Die Posen-Bibliothek fehlt in dieser Seite.");
      if (!inlineWasm) {
        status("Laufzeit wird entpackt …");
        inlineWasm = await inflate(window.__BV_ASSETS.wasm);
        status("Modell wird entpackt …");
        inlineModel = await inflate(window.__BV_ASSETS.model);
      }
      if (state.landmarker) return state.landmarker.instance;

      status("Posenerkennung wird gestartet …");
      const build = async (delegate) => {
        // The bundle clears both globals after it uses them, so they are set
        // again for every attempt. `Module.wasmBinary` is the hook that stops
        // Emscripten from fetching the WebAssembly it already has.
        self.ModuleFactory = window.__BV_MODULE_FACTORY;
        self.Module = { wasmBinary: inlineWasm };
        return visionModule.PoseLandmarker.createFromOptions(
          { wasmLoaderPath: "", wasmBinaryPath: "" },
          {
            baseOptions: { modelAssetBuffer: inlineModel, delegate },
            runningMode: "VIDEO",
            numPoses: 2,
            minPoseDetectionConfidence: 0.3,
            minPosePresenceConfidence: 0.3,
            minTrackingConfidence: 0.3,
            outputSegmentationMasks: false,
          },
        );
      };
      let instance;
      try {
        instance = await build("GPU");
      } catch (err) {
        status("Keine GPU verfügbar, es wird auf der CPU gerechnet — das dauert länger.");
        instance = await build("CPU");
      }
      state.landmarker = { modelFile: "inline", instance };
      return instance;
    }

    if (!visionModule) {
      status("Laufzeit wird geladen …");
      visionModule = await import(VENDOR + "vision_bundle.mjs");
    }
    if (state.landmarker && state.landmarker.modelFile === modelFile) return state.landmarker.instance;
    if (state.landmarker) state.landmarker.instance.close();

    status("Modell wird geladen (einmalig, ca. 9 MB) …");
    const fileset = await visionModule.FilesetResolver.forVisionTasks("./vendor");
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: VENDOR + modelFile, delegate },
      runningMode: "VIDEO",
      numPoses: 2,
      // A serve is fast and self-occluding; a lower gate keeps the racket arm
      // rather than dropping it, and the pipeline weights by score anyway.
      minPoseDetectionConfidence: 0.3,
      minPosePresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
      outputSegmentationMasks: false,
    });
    let instance;
    try {
      instance = await visionModule.PoseLandmarker.createFromOptions(fileset, options("GPU"));
    } catch (err) {
      // Machines without a usable WebGL context still work, several times
      // slower. Failing outright here would look like the video was the
      // problem.
      status("Keine GPU verfügbar, es wird auf der CPU gerechnet — das dauert länger.");
      instance = await visionModule.PoseLandmarker.createFromOptions(fileset, options("CPU"));
    }
    state.landmarker = { modelFile, instance };
    return instance;
  }

  /* ---------------------------------------------------------------- */
  /* Reading the video                                                 */
  /* ---------------------------------------------------------------- */

  function loadVideo(file, sourceUrl) {
    state.file = file;
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = sourceUrl || URL.createObjectURL(file);

    video.addEventListener("loadedmetadata", () => {
      state.video = video;
      state.width = video.videoWidth;
      state.height = video.videoHeight;
      state.coverage = null;
      $("videoname").textContent = file.name;
      $("videometa").textContent =
        video.videoWidth +
        "×" +
        video.videoHeight +
        " · " +
        video.duration.toFixed(2) +
        " s";
      $("videobadge").dataset.active = "true";
      $("video-settings").hidden = false;
      // A serve is under two seconds. Offering the whole of a thirty-second
      // clip by default would mean a four-minute wait that looks like a hang.
      $("v-start").max = String(video.duration.toFixed(1));
      $("v-end").max = String(video.duration.toFixed(1));
      $("v-status").textContent =
        "Körpergröße und Schlaghand eintragen, dann Analyse starten. Alles Weitere findet die App selbst.";
      step(2);
      $("video-settings").scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    video.addEventListener("error", () => {
      // Some sandboxes refuse blob: URLs for media. Reading the file into a
      // data URL costs memory but needs no URL scheme at all, so it is worth
      // one retry before telling anyone their video is at fault.
      if (!sourceUrl) {
        const reader = new FileReader();
        reader.onload = () => loadVideo(file, String(reader.result));
        reader.onerror = () =>
          window.Playground.fail("Die Videodatei konnte nicht gelesen werden (" + file.name + ").");
        reader.readAsDataURL(file);
        return;
      }
      window.Playground.fail(
        "Der Browser kann dieses Video nicht dekodieren (" +
          file.name +
          "). Chrome und Safari lesen H.264-MP4 und WebM; HEVC aus dem iPhone oft nicht. " +
          "Abhilfe: in der Foto-App als „Kompatibel“ exportieren oder mit " +
          "ffmpeg -i " + file.name + " -c:v libx264 out.mp4 umwandeln.",
      );
    });
  }

  /**
   * Frame rate of the file, measured rather than assumed.
   *
   * No browser API reports it. `requestVideoFrameCallback` gives the
   * presentation time of each frame it paints, so playing a short stretch and
   * timing the frames it hands over measures the real rate — which decides
   * whether timing analysis is admissible at all.
   */
  async function measureFrameRate(video) {
    if (!video.requestVideoFrameCallback) return 30;
    const times = [];
    await new Promise((resolve) => {
      const step = (_now, metadata) => {
        times.push(metadata.mediaTime);
        if (times.length >= 60) {
          video.pause();
          resolve();
          return;
        }
        video.requestVideoFrameCallback(step);
      };
      video.currentTime = 0;
      video.requestVideoFrameCallback(step);
      video.play().catch(() => resolve());
      setTimeout(() => {
        video.pause();
        resolve();
      }, 5000);
    });

    const deltas = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0.0005) deltas.push(d);
    }
    if (!deltas.length) return 30;
    deltas.sort((a, b) => a - b);

    // The *smallest* interval between painted frames, not the typical one.
    //
    // A player that cannot keep up drops frames, and a dropped frame doubles or
    // triples the gap in media time. Taking the median of those gaps measures
    // how busy the machine was; taking the low end measures the video. On a
    // 55 fps clip the difference was 20 fps against 55 — and the frame rate is
    // what every timing measurement is divided by.
    const low = deltas[Math.max(0, Math.floor(deltas.length * 0.1))];
    const measured = 1 / low;
    // Clips are authored at a handful of rates; snapping to the nearest of them
    // removes the last of the jitter, but only when it is genuinely near one.
    const COMMON = [24, 25, 30, 50, 55, 60, 100, 120, 240];
    const near = COMMON.find((rate) => Math.abs(rate - measured) / rate < 0.04);
    return near ?? Math.round(measured);
  }

  const seekTo = (video, time) =>
    new Promise((resolve) => {
      const done = () => {
        video.removeEventListener("seeked", done);
        resolve();
      };
      video.addEventListener("seeked", done);
      video.currentTime = time;
    });

  /* ---------------------------------------------------------------- */
  /* Extraction                                                        */
  /* ---------------------------------------------------------------- */

  async function extract() {
    const video = state.video;
    if (!video) return;

    const button = $("v-extract");
    button.disabled = true;
    button.textContent = "Analyse läuft …";
    step(3);
    progress(0);
    const status = (text) => ($("v-status").textContent = text);

    try {
      if (!(await vendorPresent())) {
        window.Playground.fail(
          "Das Pose-Modell fehlt. Es wird nicht mitgeliefert (24 MB) und muss einmalig geladen werden: " +
            "im Ordner engine „node --experimental-strip-types tools/fetch-models.ts“ ausführen, " +
            "danach den Server neu starten und diese Seite neu laden.",
        );
        status("Modell fehlt.");
        return;
      }
      const landmarker = await loadLandmarker($("v-model").value);

      status("Bildrate wird gemessen …");
      state.fps = await measureFrameRate(video);

      const canvas = document.createElement("canvas");
      canvas.width = state.width;
      canvas.height = state.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      // Thumbnails for the marking view are kept small; the estimator sees the
      // full frame.
      const thumb = document.createElement("canvas");
      const thumbScale = Math.min(1, 640 / state.width);
      thumb.width = Math.round(state.width * thumbScale);
      thumb.height = Math.round(state.height * thumbScale);
      const thumbCtx = thumb.getContext("2d");

      // The whole video unless someone said otherwise. Finding the serve is the
      // app's job, not a number the reader has to look up.
      let startS = Math.max(0, Number($("v-start").value) || 0);
      let endS = Math.min(video.duration, Number($("v-end").value) || video.duration);

      // A long clip is searched before it is measured.
      //
      // Somebody hands the app a rally, a warm-up or a whole game and expects
      // the serve to be found. Stepping through every frame of that at three
      // frames a second is minutes of waiting for material that is mostly
      // someone walking to the baseline. So: a coarse sweep first, ten times
      // faster, to find where the hitting hand goes highest; then the careful
      // pass over the two seconds around it.
      const spanFrames = (endS - startS) * state.fps;
      if (spanFrames > 400 && !Number($("v-start").value) && !Number($("v-end").value)) {
        status("Der Aufschlag wird im Video gesucht …");
        const range = await findStroke(video, landmarker, canvas, ctx, startS, endS, status);
        if (range) {
          startS = range.startS;
          endS = range.endS;
          status(
            `Aufschlag gefunden bei ${range.centreS.toFixed(1)} s. Ausgewertet wird ` +
              `${startS.toFixed(1)}–${endS.toFixed(1)} s.`,
          );
        }
      }

      const available = Math.max(1, Math.floor((endS - startS) * state.fps));
      // A ceiling so a mistyped range cannot turn into a ten-minute wait.
      const total = Math.min(900, available);
      state.startS = startS;
      const flip = $("v-flipdepth").checked ? -1 : 1;
      lastCentre = null;
      const frames = [];
      const thumbnails = [];
      const signatures = [];
      let found = 0;
      const startedAt = Date.now();

      for (let i = 0; i < total; i++) {
        const t = startS + i / state.fps;
        if (t >= video.duration) break;
        await seekTo(video, t);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Timestamps must increase strictly; the frame index in milliseconds
        // does that even when two frames share a presentation time.
        const result = landmarker.detectForVideo(canvas, nextTimestamp());

        const keypoints = new Array(33).fill(null);
        let depth = null;
        // Courts have more than one person on them: an opponent at the far
        // baseline, a ball kid at the fence. The server is the largest figure
        // in the frame, so the largest pose is the one to keep.
        const chosen = pickPose(result.landmarks, lastCentre);
        if (chosen >= 0) {
          found++;
          const image = result.landmarks[chosen];
          for (let k = 0; k < image.length; k++) {
            const lm = image[k];
            const score = lm.visibility === undefined ? 0.8 : lm.visibility;
            keypoints[k] = [
              Math.round(lm.x * state.width * 100) / 100,
              Math.round(lm.y * state.height * 100) / 100,
              Math.round(score * 1000) / 1000,
            ];
          }
          const world = result.worldLandmarks && result.worldLandmarks[chosen];
          if (world) {
            // World landmarks are metres from the hip centre. MediaPipe's z
            // grows away from the camera, which is the direction the clip
            // format calls depth.
            depth = world.map((lm) => Math.round(lm.z * flip * 10000) / 10000);
          }
        }

        const frame = { t: Math.round((t - startS) * 1e6) / 1e6, keypoints };
        if (depth) frame.depth = depth;
        frames.push(frame);

        thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
        const image = thumbCtx.getImageData(0, 0, thumb.width, thumb.height);
        thumbnails.push(image);
        signatures.push(signature(image));

        if (i % 5 === 0) {
          const perFrame = (Date.now() - startedAt) / Math.max(1, i + 1);
          const remaining = Math.round((perFrame * (total - i - 1)) / 1000);
          progress((i + 1) / total);
          status(
            `Bild ${i + 1} von ${total} · ${found} mit erkannter Person` +
              (remaining > 2 ? ` · noch ca. ${remaining} s` : ""),
          );
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      // How many of these frames carry new image content?
      //
      // A screen recording of a slowed replay holds every source frame for
      // several screen frames. The file then claims 55 fps while the motion
      // advances 14 times a second, and every velocity computed from it is
      // wrong by the ratio — three frames out of four say the player did not
      // move at all. Keeping the duplicates would be worse than useless, so
      // they are dropped and the rate is corrected to the one that is real.
      const distinct = [frames[0]];
      const distinctThumbs = [thumbnails[0]];
      for (let i = 1; i < frames.length; i++) {
        if (pictureChanged(signatures[i - 1], signatures[i])) {
          distinct.push(frames[i]);
          distinctThumbs.push(thumbnails[i]);
        }
      }
      const duplicateFraction = 1 - distinct.length / Math.max(1, frames.length);
      state.duplicateFraction = duplicateFraction;
      if (duplicateFraction > 0.15) {
        const effective = state.fps * (distinct.length / frames.length);
        state.effectiveFps = effective;
        // Timestamps are rebuilt on the distinct rate, so the analysis measures
        // the motion rather than the repetition.
        distinct.forEach((frame, index) => {
          frame.t = Math.round((index / effective) * 1e6) / 1e6;
        });
        state.frames = distinct;
        state.thumbnails = distinctThumbs;
        state.fps = Math.round(effective * 100) / 100;
      } else {
        state.frames = frames;
        state.thumbnails = thumbnails;
      }

      state.coverage = found / Math.max(1, frames.length);
      state.height = state.height || 0;
      state.playerHeightPx = medianPlayerHeight(state.frames);

      if (!found) {
        window.Playground.fail(
          "In keinem Bild wurde eine Person erkannt. Häufigste Ursachen: Der Spieler ist zu klein im " +
            "Bild (er sollte mindestens ein Drittel der Bildhöhe einnehmen), die Aufnahme ist zu dunkel, " +
            "oder es ist eine Totale vom ganzen Platz.",
        );
        status("Keine Person erkannt.");
        return;
      }

      // Exposed so the extracted track can be inspected without re-running the
      // estimator; the analysis never reads it.
      window.__BV_FRAMES = state.frames;
      renderFit();
      status(
        `${state.frames.length} Bilder bei ${state.fps} fps, in ` +
          `${Math.round((found / frames.length) * 100)} % eine Person erkannt.` +
          (duplicateFraction > 0.15
            ? ` ${Math.round(duplicateFraction * 100)} % der Bilder waren Wiederholungen des ` +
              "vorigen — die Aufnahme läuft in Zeitlupe oder wurde von einem Bildschirm abgefilmt. " +
              "Gerechnet wird mit der tatsächlichen Bildfolge."
            : "") +
          " Jetzt den Treffpunkt markieren.",
      );
      $("v-fps").value = String(state.fps);
      $("v-fps-row").hidden = false;
      openMarker();
    } catch (err) {
      window.Playground.fail("Die Posenerkennung ist gescheitert: " + String((err && err.message) || err));
      status("Fehlgeschlagen.");
    } finally {
      button.disabled = false;
      button.textContent = "Analyse starten";
      progress(null);
    }
  }

  /**
   * Did the pose change between two frames?
   *
   * Comparing the estimated joints rather than the pixels is deliberate: the
   * estimator is deterministic, so an identical image yields identical
   * landmarks to the last decimal, while a genuinely new image moves at least
   * some of them. Crowd movement in the background cannot fool it.
   */
  function pictureChanged(a, b) {
    if (!a || !b) return true;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    // Two decodes of the same source frame are bit-identical; anything the
    // player actually did moves several of these cells by more than noise.
    return sum / a.length > 0.6;
  }

  /**
   * Coarse sweep for the stroke in a long clip.
   *
   * Samples about forty frames across the whole video, scores each by how far
   * the hitting hand is above the shoulder, and returns a window of a couple of
   * seconds around the best one. It only has to be right to within a second;
   * the fine pass does the rest.
   */
  async function findStroke(video, landmarker, canvas, ctx, startS, endS, status) {
    const samples = 40;
    lastCentre = null;
    const sampled = [];
    for (let i = 0; i < samples; i++) {
      const t = startS + ((endS - startS) * i) / (samples - 1);
      await seekTo(video, Math.min(t, video.duration - 0.001));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const result = landmarker.detectForVideo(canvas, nextTimestamp());
      const chosen = pickPose(result.landmarks, lastCentre);
      if (chosen >= 0) {
        const pose = result.landmarks[chosen];
        sampled.push({
          t,
          keypoints: pose.map((lm) => [lm.x * state.width, lm.y * state.height, lm.visibility ?? 0.8]),
        });
      }
      if (i % 5 === 0) {
        progress(i / samples);
        status(`Suche den Aufschlag … ${Math.round((i / samples) * 100)} %`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    const peak = highestHand(sampled);
    if (peak === null) return null;
    const centre = sampled[peak].t;
    // The stroke runs from the wind-up to the landing, and the hand is highest
    // at contact — so most of the window belongs before it.
    return {
      centreS: centre,
      startS: Math.max(startS, centre - 1.8),
      endS: Math.min(endS, centre + 1.0),
    };
  }

  /**
   * Which of the detected people is the player?
   *
   * The largest figure, until there is a previous frame to compare with — after
   * that, the one nearest to where the player just was. On the Alcaraz clip the
   * size rule alone jumped to a spectator in six frames out of forty-three, and
   * a wrist that teleports into the stands is worse than a missing one, because
   * it looks like a measurement.
   */
  function pickPose(all, previous) {
    if (!all || !all.length) return -1;
    const centreOf = (pose) => {
      const hipL = pose[23];
      const hipR = pose[24];
      if (!hipL || !hipR) return null;
      return { x: (hipL.x + hipR.x) / 2, y: (hipL.y + hipR.y) / 2 };
    };
    const sizeOf = (pose) => {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const lm of pose) {
        if (lm.y < minY) minY = lm.y;
        if (lm.y > maxY) maxY = lm.y;
      }
      return maxY - minY;
    };

    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < all.length; i++) {
      const size = sizeOf(all[i]);
      const centre = centreOf(all[i]);
      let score = size;
      if (previous && centre) {
        // Normalised distance travelled since the last frame; a real player
        // moves a fraction of his own height between frames.
        const moved = Math.hypot(centre.x - previous.x, centre.y - previous.y);
        score = size - moved * 3;
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) {
      const centre = centreOf(all[best]);
      if (centre) lastCentre = centre;
    }
    return best;
  }

  /** Hip midpoint of the pose kept in the previous frame, in normalised units. */
  let lastCentre = null;

  /** Median nose-to-ankle distance in pixels: how large the player is. */
  function medianPlayerHeight(frames) {
    const values = [];
    for (const frame of frames) {
      const nose = frame.keypoints[0];
      const ankle = frame.keypoints[28] || frame.keypoints[27];
      if (!nose || !ankle || nose[2] < 0.2 || ankle[2] < 0.2) continue;
      values.push(Math.hypot(nose[0] - ankle[0], nose[1] - ankle[1]));
    }
    if (!values.length) return 0;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] / 0.936;
  }

  /** A 24×24 luma thumbprint of a frame, for the duplicate test. */
  function signature(image) {
    const cells = 24;
    const out = new Float32Array(cells * cells);
    const stepX = image.width / cells;
    const stepY = image.height / cells;
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const x = Math.min(image.width - 1, Math.floor((cx + 0.5) * stepX));
        const y = Math.min(image.height - 1, Math.floor((cy + 0.5) * stepY));
        const i = (y * image.width + x) * 4;
        out[cy * cells + cx] = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Marking the contact frame                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Proposes the contact frame from the pose alone.
   *
   * At contact the hitting hand is at its highest and the arm at its longest;
   * both peak within a frame or two of the ball leaving the strings. Neither is
   * exact — the racket keeps extending after the wrist stops — so this is a
   * proposal to be corrected by eye, not a measurement. But it puts the
   * playhead within a couple of frames of the answer, which is the difference
   * between confirming something and hunting for it.
   */
  function proposeContact() {
    const best = highestHand(state.frames);
    return best === null ? Math.floor(state.frames.length / 2) : best;
  }

  /**
   * Frame in which the hitting hand stands highest above the shoulder.
   *
   * Only frames where the hand is genuinely above the shoulder count. An
   * earlier version added the arm's reach to the height and scored the
   * follow-through highest, because a fully extended arm pointing down is long
   * too — the picked frame was half a second past contact. Reach only breaks
   * ties among frames that already have the hand overhead, and everything is
   * divided by the shoulder width so a zoom cannot tilt the choice.
   */
  function highestHand(frames) {
    const side = $("v-hand").value === "left"
      ? { hand: 19, wrist: 15, shoulder: 11, other: 12 }
      : { hand: 20, wrist: 16, shoulder: 12, other: 11 };
    const raw = frames.map((frame) => {
      const point = frame.keypoints[side.hand] && frame.keypoints[side.hand][2] > 0.2
        ? frame.keypoints[side.hand]
        : frame.keypoints[side.wrist];
      const shoulder = frame.keypoints[side.shoulder];
      const other = frame.keypoints[side.other];
      if (!point || !shoulder || point[2] < 0.2) return null;
      const width = other ? Math.hypot(shoulder[0] - other[0], shoulder[1] - other[1]) : 0;
      const scale = width > 4 ? width : 40;
      // The image y axis points down, so "above" is a positive difference.
      return (shoulder[1] - point[1]) / scale;
    });

    // Median of three before the maximum. A single mis-detected frame — the
    // estimator finding an arm where there is none — otherwise wins outright,
    // and picked frame 2 of 43 on a clip whose contact was at 32.
    let best = null;
    for (let i = 0; i < raw.length; i++) {
      const around = [raw[i - 1], raw[i], raw[i + 1]].filter((v) => v !== null && v !== undefined);
      if (around.length < 2 || raw[i] === null) continue;
      around.sort((a, b) => a - b);
      const smoothed = around[Math.floor(around.length / 2)];
      if (smoothed <= 0) continue;
      if (!best || smoothed > best.score) best = { index: i, score: smoothed };
    }
    return best ? best.index : null;
  }

  function openMarker() {
    const panel = $("mark-panel");
    panel.hidden = false;
    const slider = $("mark-frame");
    slider.max = String(state.frames.length - 1);
    const proposed = proposeContact();
    slider.value = String(proposed);
    state.contactFrame = proposed;
    $("mark-current").textContent = "Vorschlag: Bild " + proposed + " — mit ◀ ▶ prüfen";
    $("mark-aside").textContent = state.frames.length + " Bilder · " + state.fps + " fps";
    drawMark(proposed);
    step(3);
    panel.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function drawMark(index) {
    const canvas = $("mark-canvas");
    const image = state.thumbnails[index];
    if (!image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    const ctx = canvas.getContext("2d");
    ctx.putImageData(image, 0, 0);

    // The detected pose, drawn over the frame: seeing where the estimator
    // thinks the wrist is says more about whether this will work than any
    // quality score can.
    const frame = state.frames[index];
    const scale = canvas.width / state.width;
    ctx.strokeStyle = "rgba(77, 189, 180, 0.95)";
    ctx.fillStyle = "rgba(77, 189, 180, 0.95)";
    ctx.lineWidth = 2;
    const BONES = [
      [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
      [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
      [24, 26], [26, 28], [27, 31], [28, 32],
    ];
    for (const [a, b] of BONES) {
      const pa = frame.keypoints[a];
      const pb = frame.keypoints[b];
      if (!pa || !pb || pa[2] < 0.15 || pb[2] < 0.15) continue;
      ctx.beginPath();
      ctx.moveTo(pa[0] * scale, pa[1] * scale);
      ctx.lineTo(pb[0] * scale, pb[1] * scale);
      ctx.stroke();
    }
    for (const kp of frame.keypoints) {
      if (!kp || kp[2] < 0.15) continue;
      ctx.beginPath();
      ctx.arc(kp[0] * scale, kp[1] * scale, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    $("mark-label").textContent =
      "Bild " + index + " · " + (index / state.fps).toFixed(3) + " s";
  }

  /* ---------------------------------------------------------------- */
  /* Handing over to the engine                                        */
  /* ---------------------------------------------------------------- */

  /**
   * What this footage can carry.
   *
   * Every clip gets analysed; not every clip can support every claim, and the
   * honest thing is to say which is which before the report does. The four
   * things that decide it are all measured rather than assumed: how often the
   * picture actually changes, how large the player is in it, how reliably the
   * estimator found him, and whether the focal length is known.
   */
  function assessFootage() {
    const rate = state.fps;
    const coverage = state.coverage ?? 1;
    const heightPx = state.playerHeightPx ?? 0;
    const relative = state.height ? heightPx / state.height : 0;
    const rows = [];

    rows.push({
      label: "Bildfolge",
      value: rate.toFixed(0) + " Hz",
      verdict:
        rate >= 120
          ? { tone: "good", text: "reicht für die Kette und für Schlägergeschwindigkeit" }
          : rate >= 60
            ? { tone: "warn", text: "reicht für Winkel und Treffpunkt, nicht für die Kettenzeiten" }
            : { tone: "alert", text: "zu grob für Zeitmessungen; Winkel nur als Anhaltspunkt" },
    });
    rows.push({
      label: "Spieler im Bild",
      value: Math.round(relative * 100) + " % der Bildhöhe",
      verdict:
        relative >= 0.45
          ? { tone: "good", text: "groß genug für stabile Gelenkpunkte" }
          : relative >= 0.25
            ? { tone: "warn", text: "klein; die Gelenkpunkte werden unruhig" }
            : { tone: "alert", text: "zu klein — näher heran oder zuschneiden" },
    });
    rows.push({
      label: "Erkennung",
      value: Math.round(coverage * 100) + " % der Bilder",
      verdict:
        coverage >= 0.95
          ? { tone: "good", text: "der Spieler wurde durchgehend gefunden" }
          : coverage >= 0.8
            ? { tone: "warn", text: "einzelne Lücken werden überbrückt" }
            : { tone: "alert", text: "zu viele Lücken für eine durchgehende Bewegung" },
    });
    const hfov = Number($("v-hfov").value);
    rows.push({
      label: "Bildwinkel",
      value: hfov ? hfov + "°" : "unbekannt",
      verdict: hfov
        ? { tone: "good", text: "Längenangaben sind maßstabsgetreu" }
        : { tone: "warn", text: "wird geschätzt; alle Längen entsprechend unsicher" },
    });
    if (state.duplicateFraction > 0.15) {
      rows.push({
        label: "Zeitlupe",
        value: Math.round(state.duplicateFraction * 100) + " % Wiederholungen",
        verdict: {
          tone: "alert",
          text: "Bildschirmmitschnitt oder verlangsamt — gerechnet wird mit der echten Bildfolge",
        },
      });
    }
    return rows;
  }

  function renderFit() {
    const rows = assessFootage();
    const host = document.getElementById("fit-rows");
    host.innerHTML = "";
    let worst = "good";
    for (const row of rows) {
      if (row.verdict.tone === "alert") worst = "alert";
      else if (row.verdict.tone === "warn" && worst !== "alert") worst = "warn";
      const div = document.createElement("div");
      div.className = "fitrow";
      div.dataset.tone = row.verdict.tone;
      const label = document.createElement("span");
      const dot = document.createElement("i");
      dot.className = "dot";
      label.appendChild(dot);
      label.appendChild(document.createTextNode(row.label));
      const value = document.createElement("span");
      value.className = "v";
      value.textContent = row.value;
      const text = document.createElement("span");
      text.className = "t";
      text.textContent = row.verdict.text;
      div.append(label, value, text);
      host.appendChild(div);
    }
    document.getElementById("fit-aside").textContent =
      worst === "good"
        ? "trägt eine vollständige Auswertung"
        : worst === "warn"
          ? "trägt einen Teil der Auswertung"
          : "trägt nur Anhaltspunkte";
    document.getElementById("fit-panel").hidden = false;
  }

  function buildClip() {
    const corrected = Number($("v-fps").value);
    if (corrected > 0 && Math.abs(corrected - state.fps) > 0.01) {
      // The reader knows the file; the measurement is only a fallback.
      state.frames.forEach((frame, index) => {
        frame.t = Math.round((index / corrected) * 1e6) / 1e6;
      });
      state.fps = corrected;
    }
    // Without an entry, the capture rate is the rate at which the picture
    // actually changes — not the rate the container claims.
    const captureFps = Number($("v-capture").value) || state.fps;
    const hfov = Number($("v-hfov").value);
    const clip = {
      format: "baseline-vision-clip",
      version: 1,
      video: {
        fps: state.fps,
        captureFps,
        widthPx: state.width,
        heightPx: state.height,
      },
      player: {
        id: "video",
        displayName: state.file ? state.file.name : "Spieler",
        heightCm: Number($("v-height").value) || 185,
        hand: $("v-hand").value,
        backhand: "two_handed",
        level: $("v-level").value,
      },
      stroke: "serve",
      keypointLayout: LAYOUT,
      source: state.file ? state.file.name : "Video",
      frames: state.frames,
    };
    if (hfov) clip.video.hfovDeg = hfov;
    if (state.contactFrame !== null) clip.contactFrame = state.contactFrame;
    return clip;
  }

  function run() {
    if (!state.frames.length) return;
    const clip = buildClip();
    window.Playground.acceptClip(
      clip,
      state.file ? state.file.name : "Video",
      state.frames.length +
        " Bilder · " +
        state.fps +
        " fps" +
        (state.contactFrame === null ? " · kein Treffpunkt" : " · Treffpunkt " + state.contactFrame),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Is the estimator actually there?
   *
   * `fetch-models.ts` is a separate step, and forgetting it produces a 404 deep
   * inside a WebAssembly loader whose message says nothing useful. Checking
   * first turns that into one sentence naming the command that was missed.
   */
  async function vendorPresent() {
    if (inlined()) return true;
    try {
      const response = await fetch(VENDOR + "vision_bundle.mjs", { method: "HEAD" });
      return response.ok;
    } catch (err) {
      return false;
    }
  }

  function init() {
    $("video-block").hidden = false;
    if (inlined()) {
      const select = $("v-model");
      if (select) select.closest(".field").querySelector('label[for="v-model"]').hidden = true;
      if (select) select.hidden = true;
    }
    // Videos dropped on the clip zone belong here too.
    window.__videoRoute = loadVideo;
    // One zone, not two: the second one was a trap, because the file someone
    // reaches for first is the video and the older zone refused it.
    const clipBlock = $("clip-block");
    if (clipBlock) clipBlock.hidden = true;
    // On the video page the simulation is a side show, not the first thing.
    const synthetic = $("synthetic");
    if (synthetic) synthetic.hidden = true;
    // This page *is* the video page; the link to it belongs on the other one.
    const link = $("videolink");
    if (link) link.hidden = true;
    $("videozone").firstChild.nodeValue = "\n        Video oder Clip-Datei hier ablegen oder klicken\n      ";

    const input = $("videofile");
    const zone = $("videozone");
    input.addEventListener("change", () => input.files && input.files[0] && accept(input.files[0]));
    ["dragenter", "dragover"].forEach((type) =>
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.dataset.over = "true";
      }),
    );
    ["dragleave", "drop"].forEach((type) =>
      zone.addEventListener(type, (e) => {
        e.preventDefault();
        zone.dataset.over = "false";
      }),
    );
    const accept = (file) => {
      if (!file) return;
      const extension = (file.name.split(".").pop() || "").toLowerCase();
      // A clip file dropped on the video zone goes to the clip route rather
      // than being refused for sitting on the wrong half of the page.
      if (extension === "json" || file.type === "application/json") {
        if (window.Playground.loadFile) window.Playground.loadFile(file);
        return;
      }
      loadVideo(file);
    };

    zone.addEventListener("drop", (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      accept(file);
    });

    $("v-extract").addEventListener("click", extract);

    const slider = $("mark-frame");
    slider.addEventListener("input", () => drawMark(Number(slider.value)));
    $("mark-prev").addEventListener("click", () => {
      slider.value = String(Math.max(0, Number(slider.value) - 1));
      drawMark(Number(slider.value));
    });
    $("mark-next").addEventListener("click", () => {
      slider.value = String(Math.min(Number(slider.max), Number(slider.value) + 1));
      drawMark(Number(slider.value));
    });
    $("mark-set").addEventListener("click", () => {
      state.contactFrame = Number(slider.value);
      $("mark-current").textContent = "Treffpunkt: Bild " + state.contactFrame;
    });
    $("mark-run").addEventListener("click", run);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
