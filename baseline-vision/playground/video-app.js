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

  async function loadLandmarker(modelFile) {
    const status = (text) => ($("v-status").textContent = text);

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

  function loadVideo(file) {
    state.file = file;
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(file);

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
      $("v-status").textContent =
        "Bereit. Bildrate wird beim Erkennen gemessen — die Datei verrät sie nicht.";
    });

    video.addEventListener("error", () => {
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
        if (times.length >= 12) {
          video.pause();
          resolve();
          return;
        }
        video.requestVideoFrameCallback(step);
      };
      video.currentTime = 0;
      video.requestVideoFrameCallback(step);
      video.play().catch(() => resolve());
      setTimeout(resolve, 4000);
    });
    const deltas = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0.0005) deltas.push(d);
    }
    if (!deltas.length) return 30;
    deltas.sort((a, b) => a - b);
    return Math.round(1 / deltas[Math.floor(deltas.length / 2)]);
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

      // Nine hundred frames is a few seconds of high-speed footage and half a
      // minute of ordinary footage — well past a serve, and short enough that
      // the browser stays responsive.
      const available = Math.floor(video.duration * state.fps);
      const total = Math.min(900, available);
      if (available > total) {
        status(`Nur die ersten ${total} Bilder werden ausgewertet (von ${available}).`);
      }
      const flip = $("v-flipdepth").checked ? -1 : 1;
      const frames = [];
      const thumbnails = [];
      let found = 0;

      for (let i = 0; i < total; i++) {
        const t = i / state.fps;
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

        const frame = { t: Math.round(t * 1e6) / 1e6, keypoints };
        if (depth) frame.depth = depth;
        frames.push(frame);

        thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
        thumbnails.push(thumbCtx.getImageData(0, 0, thumb.width, thumb.height));

        if (i % 5 === 0) {
          status(`Bild ${i + 1} von ${total} · ${found} mit erkannter Person`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      state.frames = frames;
      state.thumbnails = thumbnails;

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
        `${frames.length} Bilder bei ${state.fps} fps, in ${Math.round((found / frames.length) * 100)} % ` +
          "eine Person erkannt. Jetzt den Treffpunkt markieren.",
      );
      openMarker();
    } catch (err) {
      window.Playground.fail("Die Posenerkennung ist gescheitert: " + String((err && err.message) || err));
      status("Fehlgeschlagen.");
    } finally {
      button.disabled = false;
    }
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

  function init() {
    $("video-block").hidden = false;

    const input = $("videofile");
    const zone = $("videozone");
    input.addEventListener("change", () => input.files && input.files[0] && loadVideo(input.files[0]));
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
    zone.addEventListener("drop", (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadVideo(file);
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
