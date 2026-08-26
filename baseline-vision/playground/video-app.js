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
            numPoses: 1,
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
      numPoses: 1,
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
      $("v-start").value = "0";
      $("v-start").max = String(video.duration.toFixed(1));
      $("v-end").max = String(video.duration.toFixed(1));
      $("v-end").value = String(Math.min(video.duration, 6).toFixed(1));
      $("v-status").textContent =
        "Bereit. Ausschnitt prüfen, dann „Posen erkennen“. Die Bildrate wird dabei gemessen — " +
        "die Datei verrät sie nicht.";
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

      const startS = Math.max(0, Number($("v-start").value) || 0);
      const endS = Math.min(video.duration, Number($("v-end").value) || video.duration);
      const available = Math.max(1, Math.floor((endS - startS) * state.fps));
      // Nine hundred frames is a hard ceiling so a mistyped range cannot turn
      // into a ten-minute wait.
      const total = Math.min(900, available);
      state.startS = startS;
      const flip = $("v-flipdepth").checked ? -1 : 1;
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
        const result = landmarker.detectForVideo(canvas, Math.round((i * 1000) / state.fps) + i);

        const keypoints = new Array(33).fill(null);
        let depth = null;
        if (result.landmarks && result.landmarks[0]) {
          found++;
          const image = result.landmarks[0];
          for (let k = 0; k < image.length; k++) {
            const lm = image[k];
            const score = lm.visibility === undefined ? 0.8 : lm.visibility;
            keypoints[k] = [
              Math.round(lm.x * state.width * 100) / 100,
              Math.round(lm.y * state.height * 100) / 100,
              Math.round(score * 1000) / 1000,
            ];
          }
          const world = result.worldLandmarks && result.worldLandmarks[0];
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

      if (!found) {
        window.Playground.fail(
          "In keinem Bild wurde eine Person erkannt. Häufigste Ursachen: Der Spieler ist zu klein im " +
            "Bild (er sollte mindestens ein Drittel der Bildhöhe einnehmen), die Aufnahme ist zu dunkel, " +
            "oder es ist eine Totale vom ganzen Platz.",
        );
        status("Keine Person erkannt.");
        return;
      }

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

  function openMarker() {
    const panel = $("mark-panel");
    panel.hidden = false;
    const slider = $("mark-frame");
    slider.max = String(state.frames.length - 1);
    slider.value = String(Math.floor(state.frames.length / 2));
    $("mark-aside").textContent = state.frames.length + " Bilder · " + state.fps + " fps";
    drawMark(Number(slider.value));
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
