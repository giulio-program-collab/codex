/* eslint-env browser */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* Engine access                                                     */
  /* ---------------------------------------------------------------- */

  const engineSource = document.getElementById("engine-source").textContent;

  // The engine runs on the main thread for the small things (metadata, and as a
  // fallback) and in a worker for the analysis itself, which takes seconds.
  (0, eval)(engineSource);
  const Engine = window.BaselineVision;
  const META = Engine.META;

  let worker = null;
  try {
    const blob = new Blob(
      [engineSource + "\nself.onmessage=function(e){try{var p=function(l,f){self.postMessage({type:'progress',label:l,fraction:f});};var r=e.data.clip?self.BaselineVision.runClip(e.data.clip,e.data.name,{},p):self.BaselineVision.run(e.data.input,p);self.postMessage({type:'done',id:e.data.id,result:r});}catch(err){self.postMessage({type:'error',id:e.data.id,message:String(err&&err.message||err)});}};"],
      { type: "text/javascript" },
    );
    worker = new Worker(URL.createObjectURL(blob));
  } catch (err) {
    worker = null;
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  const state = {
    input: {
      preset: "elite",
      level: "elite",
      ageYears: 24,
      rig: "elevatedSide",
      fps: 240,
      capture: "labor",
      knownFieldOfView: true,
      learnedDepth: true,
      repetitions: 1,
      occlusion: false,
      seed: 5,
    },
    result: null,
    frame: 0,
    view: "2d",
    playing: false,
    orbit: { azimuth: -38, elevation: 16 },
    runId: 0,
    /** A clip file the reader dropped in; when set, the controls are inert. */
    clip: null,
    clipName: "",
  };

  const LEVEL_FOR_PRESET = {
    elite: { level: "elite", ageYears: 24 },
    highPerformance: { level: "high_performance", ageYears: 21 },
    developing: { level: "junior_development", ageYears: 14 },
  };

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- */
  /* Formatting                                                        */
  /* ---------------------------------------------------------------- */

  const nf = (value, digits) =>
    value === null || value === undefined || !isFinite(value)
      ? "–"
      : value.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

  function digitsFor(unit) {
    if (unit === "s") return 3;
    if (unit === "m") return 2;
    if (unit === "") return 3;
    if (unit.indexOf("Körperhöhe") >= 0) return 2;
    return 1;
  }

  function unitLabel(unit) {
    if (unit === "deg" || unit === "°") return "°";
    if (unit === "") return "";
    return " " + unit;
  }

  function toneForConfidence(c) {
    if (c >= 0.6) return "good";
    if (c >= 0.35) return "warn";
    return "alert";
  }

  function toneForScore(score) {
    if (score >= 70) return "good";
    if (score >= 45) return "warn";
    return "alert";
  }

  const OBSERVABILITY_LABEL = {
    direct: "direkt gemessen",
    reconstructed: "rekonstruiert",
    depth_limited: "tiefenbegrenzt",
    unobservable: "nicht beobachtbar",
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* ---------------------------------------------------------------- */
  /* Controls                                                          */
  /* ---------------------------------------------------------------- */

  const FPS_OPTIONS = [30, 60, 120, 240];

  function buildControls() {
    const preset = $("preset");
    META.presets.forEach((p) => {
      const option = el("option", null, p.label);
      option.value = p.id;
      preset.appendChild(option);
    });
    preset.value = state.input.preset;
    preset.addEventListener("change", () => {
      state.input.preset = preset.value;
      Object.assign(state.input, LEVEL_FOR_PRESET[preset.value]);
      updatePresetHint();
      schedule();
    });

    const rig = $("rig");
    META.rigs.forEach((r) => {
      const option = el("option", null, r.label);
      option.value = r.id;
      rig.appendChild(option);
    });
    rig.value = state.input.rig;
    rig.addEventListener("change", () => {
      state.input.rig = rig.value;
      schedule();
    });

    const fps = $("fps");
    FPS_OPTIONS.forEach((value) => {
      const button = el("button", null, value + " fps");
      button.type = "button";
      button.setAttribute("aria-pressed", String(value === state.input.fps));
      button.addEventListener("click", () => {
        state.input.fps = value;
        Array.from(fps.children).forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        schedule();
      });
      fps.appendChild(button);
    });

    const capture = $("capture");
    META.captures.forEach((c) => {
      const button = el("button", null, c.label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(c.id === state.input.capture));
      button.addEventListener("click", () => {
        state.input.capture = c.id;
        Array.from(capture.children).forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        updateCaptureHint();
        schedule();
      });
      capture.appendChild(button);
    });

    $("knownFov").addEventListener("change", (e) => {
      state.input.knownFieldOfView = e.target.checked;
      schedule();
    });
    $("learnedDepth").addEventListener("change", (e) => {
      state.input.learnedDepth = e.target.checked;
      schedule();
    });
    $("occlusion").addEventListener("change", (e) => {
      state.input.occlusion = e.target.checked;
      schedule();
    });

    const reps = $("reps");
    reps.addEventListener("input", () => {
      state.input.repetitions = Number(reps.value);
      $("reps-value").textContent = reps.value;
    });
    reps.addEventListener("change", schedule);

    const seed = $("seed");
    seed.addEventListener("change", () => {
      const value = Math.max(1, Math.min(999, Math.round(Number(seed.value) || 1)));
      seed.value = String(value);
      state.input.seed = value;
      schedule();
    });

    const view = $("view");
    Array.from(view.children).forEach((button) => {
      button.addEventListener("click", () => {
        state.view = button.dataset.value;
        Array.from(view.children).forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        $("stage-badge").textContent = state.view === "2d" ? "Bildebene" : "Rekonstruktion, frei drehbar";
        drawStage();
      });
    });

    $("play").addEventListener("click", togglePlay);
    $("frame").addEventListener("input", (e) => {
      state.frame = Number(e.target.value);
      state.playing = false;
      $("play").textContent = "Abspielen";
      drawStage();
      updateFrameLabel();
    });

    setupClipLoading();
    updatePresetHint();
    updateCaptureHint();
    setupOrbit();
  }

  function setupClipLoading() {
    const zone = $("dropzone");
    const input = $("clipfile");

    const load = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          state.clip = JSON.parse(String(reader.result));
        } catch (err) {
          fail("Die Datei ist kein gültiges JSON: " + String((err && err.message) || err));
          return;
        }
        state.clipName = file.name;
        $("clipname").textContent = file.name;
        $("clipdepth").textContent =
          (state.clip.frames ? state.clip.frames.length + " Bilder" : "unbekannte Länge") +
          (state.clip.contactFrame !== undefined
            ? " · Treffpunkt bei " + state.clip.contactFrame
            : " · kein Treffpunkt markiert");
        $("clipbadge").dataset.active = "true";
        $("synthetic").disabled = true;
        runAnalysis();
      };
      reader.onerror = () => fail("Die Datei konnte nicht gelesen werden.");
      reader.readAsText(file);
    };

    input.addEventListener("change", () => load(input.files && input.files[0]));
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
      load(file);
    });

    $("clipclear").addEventListener("click", () => {
      state.clip = null;
      state.clipName = "";
      $("clipbadge").dataset.active = "false";
      $("synthetic").disabled = false;
      input.value = "";
      runAnalysis();
    });
  }

  const PRESET_HINTS = {
    elite: "Aufschlag auf ATP-Niveau: 66° Kniebeugung, 34° Hüft-Schulter-Trennung, Treffpunkt 2,74 m.",
    highPerformance: "Nationaler Leistungsbereich: solide Kette, etwas flachere Ladephase.",
    developing: "U14-Nachwuchs: wenig Beinarbeit, geringe Trennung, tiefer Treffpunkt.",
  };

  function updatePresetHint() {
    $("preset-hint").textContent = PRESET_HINTS[state.input.preset] || "";
  }

  function updateCaptureHint() {
    const grade = META.captures.find((c) => c.id === state.input.capture);
    $("capture-hint").textContent = grade ? grade.note : "";
  }

  /* ---------------------------------------------------------------- */
  /* Running                                                           */
  /* ---------------------------------------------------------------- */

  let timer = null;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runAnalysis, 220);
  }

  function setBusy(busy, label, fraction) {
    document.body.dataset.busy = busy ? "true" : "false";
    $("runstate-text").textContent = label;
    $("progress-bar").style.width = Math.round((fraction || 0) * 100) + "%";
  }

  function runAnalysis() {
    const id = ++state.runId;
    const input = Object.assign({}, state.input);
    const clip = state.clip;
    setBusy(true, clip ? "Clip wird eingelesen" : "Aufnahme wird gerendert", 0.02);

    if (worker) {
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === "progress") {
          setBusy(true, message.label, message.fraction);
          return;
        }
        if (message.id !== id) return;
        if (message.type === "error") {
          fail(message.message);
          return;
        }
        accept(message.result);
      };
      worker.postMessage({ id, input, clip, name: state.clipName });
      return;
    }

    // No worker available: run inline, after a paint so the busy state shows.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          accept(clip ? Engine.runClip(clip, state.clipName) : Engine.run(input));
        } catch (err) {
          fail(String((err && err.message) || err));
        }
      }),
    );
  }

  function fail(message) {
    setBusy(false, "Datei nicht lesbar");
    const host = $("clip-warnings");
    $("clip-panel").hidden = false;
    clear(host);
    const card = el("div", "card");
    card.dataset.tone = "alert";
    card.appendChild(el("h3", null, "Die Datei konnte nicht ausgewertet werden"));
    const p = el("p", null, message);
    p.style.fontSize = "0.83rem";
    p.style.color = "var(--ink-soft)";
    card.appendChild(p);
    host.appendChild(card);
  }

  function accept(result) {
    state.result = result;
    state.frame = result.contactFrame !== null ? Math.round(result.contactFrame) : 0;
    setBusy(false, "berechnet in " + (result.elapsedMs / 1000).toFixed(1) + " s");
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Rendering: verdict and quality                                    */
  /* ---------------------------------------------------------------- */

  function render() {
    const result = state.result;
    const report = result.report;

    renderVerdict(report);
    renderQuality(report.quality);
    renderStage();
    renderMetrics(report, result.truth);
    renderNotMeasurable(report);
    renderFindings(report);
    renderSession(result.session);
    renderOrigin(result);
    renderPipeline(report);

    // A real clip has no ground truth and no comparable legacy run: the old
    // method was only ever given perfect digitisation, which is what made the
    // comparison fair to it.
    $("legacy-panel").hidden = !result.legacy;
    $("truth-panel").hidden = !result.truth;
    if (result.legacy) renderLegacy(result, report);
    if (result.truth) renderTruth(result, report);
  }

  function renderOrigin(result) {
    const panel = $("clip-panel");
    if (result.origin.kind !== "clip") {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $("clip-aside").textContent = result.origin.depthPrior
      ? "Tiefenspur: " + result.origin.depthPrior
      : "ohne Tiefenspur";
    const host = $("clip-warnings");
    clear(host);
    if (!result.origin.warnings.length) {
      host.appendChild(el("p", "empty", "Die Datei enthält alles, was die Auswertung braucht."));
      return;
    }
    result.origin.warnings.forEach((warning) => {
      const card = el("div", "card");
      card.dataset.tone = "warn";
      const p = el("p", null, warning);
      p.style.fontSize = "0.85rem";
      card.appendChild(p);
      host.appendChild(card);
    });
  }

  function renderVerdict(report) {
    // The headline says what the system is willing to claim about this clip.
    // The engine's own sentence follows underneath, unedited.
    const quotable = report.metrics.filter((m) => !m.rejected && m.confidence >= 0.6).length;
    $("verdict-statement").textContent =
      report.verdict.kind === "assessment"
        ? "Diese Aufnahme trägt eine Bewertung."
        : "Diese Aufnahme trägt keine Bewertung.";
    $("verdict-explain").textContent =
      quotable +
      " von " +
      (report.metrics.length + report.notMeasurable.length) +
      " Kenngrößen sind belastbar genug, um sie zu zitieren. " +
      report.verdict.statement;
    const reasons = $("verdict-reasons");
    clear(reasons);
    report.verdict.reasons.forEach((reason) => reasons.appendChild(el("li", null, reason)));

    const scoreHost = $("verdict-score");
    clear(scoreHost);
    if (report.verdict.kind === "assessment" && typeof report.verdict.score === "number") {
      const chip = el("div", "scorechip");
      chip.appendChild(el("span", null, "Zusammenfassende Kennzahl"));
      chip.appendChild(el("b", "num", report.verdict.score + " / 100"));
      chip.appendChild(
        el("span", null, "Vertrauen " + Math.round((report.verdict.confidence || 0) * 100) + " %"),
      );
      scoreHost.appendChild(chip);
      if (report.verdict.components && report.verdict.components.length) {
        const detail = el(
          "p",
          "prose",
          "Setzt sich zusammen aus: " +
            report.verdict.components
              .map((c) => c.label + " " + Math.round(c.score) + " (Gewicht " + c.weight.toFixed(2) + ")")
              .join(", ") +
            ".",
        );
        detail.style.marginTop = "0.5rem";
        detail.style.fontSize = "0.78rem";
        scoreHost.appendChild(detail);
      }
    }

    $("verdict-aside").textContent =
      report.verdict.kind === "assessment" ? "Bewertung möglich" : "keine belastbare Bewertung";
  }

  function renderQuality(quality) {
    $("quality-value").textContent = quality.overall;
    const rows = $("quality-rows");
    clear(rows);
    quality.components.forEach((component) => {
      const row = el("div", "qrow");
      row.appendChild(el("span", null, component.label));
      const track = el("span", "track");
      const fill = el("i");
      // A component the material never contained is not a bad score, and the
      // bar must not draw it as one.
      const missing = component.applicable === false;
      fill.style.width = missing ? "0%" : Math.max(0, Math.min(100, component.score)) + "%";
      fill.dataset.level = component.score >= 70 ? "good" : component.score >= 45 ? "warn" : "alert";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "val", missing ? "n. v." : component.score));
      row.title = missing ? "Im Material nicht enthalten." : component.remedy || "";
      rows.appendChild(row);
    });

    const blockers = $("quality-blockers");
    clear(blockers);
    if (quality.blockers.length) {
      const card = el("div", "card");
      card.dataset.tone = "alert";
      card.appendChild(el("h3", null, "Was eine Bewertung verhindert"));
      quality.blockers.forEach((b) => {
        const p = el("p", null, b);
        p.style.fontSize = "0.82rem";
        p.style.color = "var(--ink-soft)";
        card.appendChild(p);
      });
      blockers.appendChild(card);
    } else {
      const worst = quality.components.slice().sort((a, b) => a.score - b.score)[0];
      if (worst && worst.remedy && worst.score < 80) {
        const hint = el("p", "prose", "Schwächster Anteil: " + worst.label + ". " + worst.remedy);
        hint.style.fontSize = "0.8rem";
        blockers.appendChild(hint);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering: stage                                                  */
  /* ---------------------------------------------------------------- */

  let cropBox = null;

  function renderStage() {
    const result = state.result;
    const slider = $("frame");
    slider.max = String(Math.max(0, result.overlay.length - 1));
    slider.value = String(Math.min(state.frame, result.overlay.length - 1));
    state.frame = Number(slider.value);
    cropBox = computeCrop(result.overlay, result.video);

    $("stage-aside").textContent =
      result.video.widthPx +
      "×" +
      result.video.heightPx +
      " · " +
      result.video.fps +
      " fps · " +
      result.overlay.length +
      " Bilder";

    renderPhases();
    updateFrameLabel();
    drawStage();
  }

  /**
   * A camera operator, in fifteen lines.
   *
   * The union of everything the clip contains is far wider than the player: a
   * serve travels forward, lands sideways, and the racket sweeps a long arc.
   * Cropping to that union leaves a matchstick figure in an empty rectangle.
   * Instead the window keeps a constant size — so nothing appears to zoom —
   * and follows a smoothed centre, the way a person holding the camera would.
   */
  function computeCrop(frames, video) {
    const boxes = frames.map((frame) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const seen = (p) => {
        if (!p) return;
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]);
        maxY = Math.max(maxY, p[1]);
      };
      frame.d.forEach(seen);
      frame.r.forEach(seen);
      if (frame.racket) {
        seen([frame.racket[0], frame.racket[1]]);
        seen([frame.racket[2], frame.racket[3]]);
      }
      // The ball is deliberately left out: its flight after contact would push
      // the window wide enough to make the player a few pixels tall.
      return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
    });

    const present = boxes.filter(Boolean);
    if (!present.length) return null;

    const quantile = (values, q) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    };
    const w = quantile(present.map((b) => b.maxX - b.minX), 0.97) * 1.18 + 40;
    const h = quantile(present.map((b) => b.maxY - b.minY), 0.97) * 1.06 + 40;

    // Smoothed centre, with gaps filled from the nearest frame that has one.
    const centres = boxes.map((b) => (b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null));
    for (let i = 0; i < centres.length; i++) {
      if (centres[i]) continue;
      let back = i;
      while (back >= 0 && !centres[back]) back--;
      let forward = i;
      while (forward < centres.length && !centres[forward]) forward++;
      centres[i] = centres[back] || centres[forward];
    }
    const window = Math.max(2, Math.round(frames.length / 12));
    const smoothed = centres.map((_, i) => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let k = Math.max(0, i - window); k <= Math.min(centres.length - 1, i + window); k++) {
        sx += centres[k].x;
        sy += centres[k].y;
        n++;
      }
      return { x: sx / n, y: sy / n };
    });

    return {
      w,
      h,
      windows: smoothed.map((c) => ({
        x: Math.max(-w * 0.2, Math.min(video.widthPx - w * 0.8, c.x - w / 2)),
        y: Math.max(-h * 0.2, Math.min(video.heightPx - h * 0.8, c.y - h / 2)),
      })),
    };
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const STAGE_HEIGHT = 460;

  function drawStage() {
    const canvas = $("stage");
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const available = Math.max(240, (canvas.parentElement.clientWidth || 900) - 10);
    const aspect = state.view === "3d" ? 1.25 : cropBox ? Math.max(0.4, cropBox.w / cropBox.h) : 16 / 9;
    let height = Math.min(STAGE_HEIGHT, Math.round(window.innerHeight * 0.62));
    let width = Math.round(height * aspect);
    if (width > available) {
      width = available;
      height = Math.round(width / aspect);
    }
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!state.result) return;
    if (state.view === "2d") draw2D(ctx, width, height);
    else draw3D(ctx, width, height);
  }

  function draw2D(ctx, width, height) {
    const frame = state.result.overlay[state.frame];
    if (!frame || !cropBox) return;
    const box = cropBox.windows[Math.min(state.frame, cropBox.windows.length - 1)];
    const sx = width / cropBox.w;
    const sy = height / cropBox.h;
    const map = (p) => (p ? [(p[0] - box.x) * sx, (p[1] - box.y) * sy] : null);

    const ink = cssVar("--ink-faint");
    const accent = cssVar("--accent");
    const ball = cssVar("--truth-line");

    // Detected 2D pose: thin and dashed, because it is an observation.
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = ink;
    drawSkeleton(ctx, frame.d.map(map));
    ctx.setLineDash([]);

    // Reprojected reconstruction: this is what the system believes.
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = accent;
    drawSkeleton(ctx, frame.r.map(map));

    ctx.fillStyle = accent;
    frame.r.map(map).forEach((p) => {
      if (!p) return;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 2.1, 0, Math.PI * 2);
      ctx.fill();
    });

    if (frame.racket) {
      const a = map([frame.racket[0], frame.racket[1]]);
      const b = map([frame.racket[2], frame.racket[3]]);
      ctx.strokeStyle = ball;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(b[0], b[1], 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (frame.ball) {
      const p = map(frame.ball);
      ctx.fillStyle = ball;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSkeleton(ctx, points) {
    META.bones.forEach((bone) => {
      const a = points[bone[0]];
      const b = points[bone[1]];
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    });
  }

  function draw3D(ctx, width, height) {
    const frame = state.result.overlay[state.frame];
    if (!frame) return;

    const az = (state.orbit.azimuth * Math.PI) / 180;
    const el2 = (state.orbit.elevation * Math.PI) / 180;

    // Centre on the pelvis so the figure stays put while the camera orbits.
    const points = frame.p.filter(Boolean);
    if (!points.length) return;
    const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
    const cy = points.reduce((s, p) => s + p[1], 0) / points.length;

    const scale = Math.min(width, height) / 3.6;
    const originY = height * 0.9;

    const projectPoint = (p) => {
      if (!p) return null;
      const x = p[0] - cx;
      const y = p[1] - cy;
      const z = p[2];
      const rx = x * Math.cos(az) - y * Math.sin(az);
      const ry = x * Math.sin(az) + y * Math.cos(az);
      return [width / 2 + rx * scale, originY - (z * Math.cos(el2) + ry * Math.sin(el2)) * scale];
    };

    // Ground grid, so the vertical the system found is visible as a plane.
    ctx.strokeStyle = cssVar("--line");
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      const a = projectPoint([cx + i * 0.5, cy - 1.0, 0]);
      const b = projectPoint([cx + i * 0.5, cy + 1.0, 0]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      const c = projectPoint([cx - 1.0, cy + i * 0.5, 0]);
      const d = projectPoint([cx + 1.0, cy + i * 0.5, 0]);
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(d[0], d[1]);
      ctx.stroke();
    }

    const projected = frame.p.map(projectPoint);
    ctx.strokeStyle = cssVar("--accent");
    ctx.lineWidth = 2.6;
    drawSkeleton(ctx, projected);
    ctx.fillStyle = cssVar("--accent");
    projected.forEach((p) => {
      if (!p) return;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 2.4, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = cssVar("--ink-faint");
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText("ziehen zum Drehen", 10, height - 10);
  }

  function setupOrbit() {
    const canvas = $("stage");
    let dragging = false;
    let last = null;
    const down = (e) => {
      if (state.view !== "3d") return;
      dragging = true;
      last = pointer(e);
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      const now = pointer(e);
      state.orbit.azimuth += (now.x - last.x) * 0.5;
      state.orbit.elevation = Math.max(-10, Math.min(80, state.orbit.elevation + (now.y - last.y) * 0.3));
      last = now;
      drawStage();
      e.preventDefault();
    };
    const up = () => {
      dragging = false;
    };
    const pointer = (e) => (e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY });
    canvas.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    canvas.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
    window.addEventListener("resize", drawStage);
  }

  function renderPhases() {
    const host = $("phases");
    clear(host);
    const phases = state.result.phases;
    if (!phases.length) return;
    const span0 = phases.reduce((sum, p) => sum + Math.max(1, p.endFrame - p.startFrame), 0);
    const total = state.result.overlay.length;
    phases.forEach((phase) => {
      const span = Math.max(1, phase.endFrame - phase.startFrame);
      // A label that does not fit is worse than none: it collides with its
      // neighbours and none of them can be read. The caption below names the
      // phase the playhead is in.
      const seg = el("div", "seg", span / span0 > 0.13 ? phase.label : "");
      seg.style.flex = span + " 1 0";
      seg.title = phase.label + " · " + nf(phase.startS, 2) + "–" + nf(phase.endS, 2) + " s · Vertrauen " + Math.round(phase.confidence * 100) + " %";
      seg.dataset.phaseStart = String(phase.startFrame);
      seg.dataset.phaseEnd = String(phase.endFrame);
      seg.addEventListener("click", () => {
        state.frame = Math.round((phase.startFrame + phase.endFrame) / 2);
        $("frame").value = String(state.frame);
        drawStage();
        updateFrameLabel();
      });
      host.appendChild(seg);
    });
    if (total) markActivePhase();
  }

  function markActivePhase() {
    let active = null;
    Array.from($("phases").children).forEach((seg, index) => {
      const start = Number(seg.dataset.phaseStart);
      const end = Number(seg.dataset.phaseEnd);
      const on = state.frame >= start && state.frame <= end;
      seg.dataset.active = String(on);
      if (on) active = state.result.phases[index];
    });
    $("phase-label").textContent = active
      ? "Phase: " + active.label + " · Grenzen mit " + Math.round(active.confidence * 100) + " % Vertrauen"
      : "";
  }

  function updateFrameLabel() {
    const result = state.result;
    if (!result) return;
    const t = state.frame / result.video.fps;
    const contact = result.contactFrame;
    const marker = contact !== null && Math.abs(contact - state.frame) < 0.5 ? " · Treffpunkt" : "";
    $("frame-label").textContent = "Bild " + state.frame + " · " + nf(t, 3) + " s" + marker;
    markActivePhase();
  }

  let playHandle = null;

  function togglePlay() {
    state.playing = !state.playing;
    $("play").textContent = state.playing ? "Anhalten" : "Abspielen";
    if (playHandle) clearInterval(playHandle);
    if (!state.playing) return;
    playHandle = setInterval(() => {
      if (!state.result) return;
      const step = Math.max(1, Math.round(state.result.video.fps / 60));
      state.frame = (state.frame + step) % state.result.overlay.length;
      $("frame").value = String(state.frame);
      drawStage();
      updateFrameLabel();
    }, 1000 / 30);
  }

  /* ---------------------------------------------------------------- */
  /* Rendering: metrics                                                */
  /* ---------------------------------------------------------------- */

  function renderMetrics(report, truthRows) {
    const host = $("metrics");
    clear(host);
    // A real clip carries no ground truth; the marks simply do not appear.
    const truthById = {};
    (truthRows || []).forEach((row) => {
      truthById[row.id] = row.truth;
    });

    report.metrics.forEach((metric) => {
      const row = el("div", "metric");
      if (metric.rejected) row.classList.add("is-rejected");

      const name = el("div", "name");
      name.appendChild(document.createTextNode(metric.label));
      name.appendChild(el("small", null, metric.phase));
      row.appendChild(name);

      row.appendChild(buildBar(metric, truthById[metric.id]));

      const value = el("div", "value");
      value.appendChild(el("div", null, metric.formatted));
      const chips = el("div");
      chips.style.marginTop = "0.25rem";
      chips.style.display = "flex";
      chips.style.gap = "0.25rem";
      chips.style.justifyContent = "flex-end";
      const conf = el("span", "chip", metric.confidenceLabel);
      conf.dataset.tone = toneForConfidence(metric.confidence);
      conf.title = "Vertrauen " + Math.round(metric.confidence * 100) + " %";
      chips.appendChild(conf);
      const obs = el("span", "chip", OBSERVABILITY_LABEL[metric.observability] || metric.observability);
      if (metric.observability === "depth_limited") obs.dataset.tone = "warn";
      if (metric.observability === "unobservable") obs.dataset.tone = "alert";
      chips.appendChild(obs);
      value.appendChild(chips);
      row.appendChild(value);

      if (metric.rejected && metric.rejectionReason) {
        const note = el("div", "note", "Verworfen: " + metric.rejectionReason);
        note.dataset.tone = "alert";
        row.appendChild(note);
      } else if (metric.reference) {
        const parts = [
          "Referenz " +
            nf(metric.reference.mean, digitsFor(metric.unit)) +
            unitLabel(metric.unit) +
            " ± " +
            nf(metric.reference.combinedSd, digitsFor(metric.unit)) +
            " (" +
            metric.reference.sourceId +
            ")",
          metric.reference.deviation,
        ];
        if (metric.reference.cohortReasons.length) parts.push(metric.reference.cohortReasons.join(" "));
        row.appendChild(el("div", "note", parts.join(" · ")));
      } else if (metric.notes.length) {
        row.appendChild(el("div", "note", metric.notes[0]));
      }

      host.appendChild(row);
    });

    if (!report.metrics.length) {
      host.appendChild(el("p", "empty", "Aus dieser Aufnahme lässt sich kein einziger Messwert gewinnen."));
    }
  }

  function buildBar(metric, truth) {
    const bar = el("div", "bar");
    const values = [];
    if (metric.interval95) values.push(metric.interval95[0], metric.interval95[1]);
    if (metric.value !== null) values.push(metric.value);
    if (metric.reference) {
      values.push(metric.reference.mean - 2 * metric.reference.combinedSd);
      values.push(metric.reference.mean + 2 * metric.reference.combinedSd);
    }
    if (typeof truth === "number") values.push(truth);
    if (!values.length) return bar;

    let lo = Math.min.apply(null, values);
    let hi = Math.max.apply(null, values);
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
    lo -= pad;
    hi += pad;
    const pos = (v) => ((v - lo) / (hi - lo)) * 100;

    bar.appendChild(el("div", "axis"));

    if (metric.reference) {
      const band = el("div", "refband");
      const left = pos(metric.reference.mean - metric.reference.combinedSd);
      const right = pos(metric.reference.mean + metric.reference.combinedSd);
      band.style.left = left + "%";
      band.style.width = Math.max(0.5, right - left) + "%";
      band.title = "Referenzspanne ±1σ";
      bar.appendChild(band);
      const mean = el("div", "refmean");
      mean.style.left = pos(metric.reference.mean) + "%";
      bar.appendChild(mean);
    }

    if (metric.interval95) {
      const interval = el("div", "interval");
      const left = pos(metric.interval95[0]);
      const right = pos(metric.interval95[1]);
      interval.style.left = left + "%";
      interval.style.width = Math.max(0.6, right - left) + "%";
      interval.style.opacity = String(0.35 + 0.65 * Math.min(1, metric.confidence / 0.8));
      interval.title = "95 %-Intervall";
      bar.appendChild(interval);
    }

    if (metric.value !== null) {
      const point = el("div", "point");
      point.style.left = pos(metric.value) + "%";
      bar.appendChild(point);
    }

    if (typeof truth === "number") {
      const mark = el("div", "truth");
      mark.style.left = pos(truth) + "%";
      mark.title = "wahrer Wert der simulierten Bewegung";
      bar.appendChild(mark);
    }

    return bar;
  }

  function renderNotMeasurable(report) {
    const host = $("notmeasurable");
    clear(host);
    $("notmeasurable-aside").textContent = report.notMeasurable.length + " Kenngrößen";
    if (!report.notMeasurable.length) {
      host.appendChild(el("p", "empty", "Unter diesen Bedingungen ist jede vorgesehene Kenngröße bestimmbar."));
      return;
    }
    report.notMeasurable.forEach((item) => {
      const card = el("div", "card");
      card.dataset.tone = "warn";
      card.appendChild(el("h3", null, item.label));
      const reason = el("p", null, item.reason);
      reason.style.fontSize = "0.83rem";
      reason.style.color = "var(--ink-soft)";
      card.appendChild(reason);
      host.appendChild(card);
    });
  }

  function renderFindings(report) {
    const host = $("findings");
    clear(host);
    if (!report.findings.length) {
      host.appendChild(el("p", "empty", "Keine Beobachtung ist belastbar genug, um daraus einen Hinweis abzuleiten."));
      return;
    }
    report.findings.forEach((finding) => {
      const card = el("div", "card");
      card.dataset.tone = toneForConfidence(finding.confidence);
      const head = el("h3", null, finding.observation);
      card.appendChild(head);
      const chip = el("span", "chip", finding.confidenceLabel);
      chip.dataset.tone = toneForConfidence(finding.confidence);
      card.appendChild(chip);
      const dl = document.createElement("dl");
      [
        ["Deutung", finding.interpretation],
        ["Konsequenz", finding.consequence],
        ["Vorschlag", finding.recommendation],
      ].forEach((pair) => {
        dl.appendChild(el("dt", null, pair[0]));
        dl.appendChild(el("dd", null, pair[1]));
      });
      card.appendChild(dl);
      host.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Rendering: session                                                */
  /* ---------------------------------------------------------------- */

  function renderSession(session) {
    const panel = $("session-panel");
    if (!session) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $("session-aside").textContent =
      session.repetitionCount + " Wiederholungen · Qualität " + session.quality + "/100";

    const notes = $("session-notes");
    clear(notes);
    const timingCard = el("div", "card");
    timingCard.dataset.tone = session.timing.allowed ? "good" : "warn";
    timingCard.appendChild(
      el("h3", null, session.timing.allowed ? "Zeitmessungen sind zugelassen" : "Zeitmessungen bleiben gesperrt"),
    );
    const timingText = el(
      "p",
      null,
      session.timing.reason ||
        "Bei dieser Bildrate genügen " +
          session.timing.required +
          " Wiederholungen, damit ein Mittelwert mit einer Population verglichen werden darf.",
    );
    timingText.style.fontSize = "0.83rem";
    timingText.style.color = "var(--ink-soft)";
    timingCard.appendChild(timingText);
    notes.appendChild(timingCard);

    session.notes.forEach((note) => {
      const card = el("div", "card");
      card.appendChild(el("p", null, note));
      notes.appendChild(card);
    });
    session.excluded.forEach((item) => {
      const card = el("div", "card");
      card.dataset.tone = "alert";
      card.appendChild(el("h3", null, "Wiederholung " + item.repetition + " ausgeschlossen"));
      const p = el("p", null, item.reason);
      p.style.fontSize = "0.83rem";
      p.style.color = "var(--ink-soft)";
      card.appendChild(p);
      notes.appendChild(card);
    });

    const host = $("session-aggregates");
    clear(host);
    session.aggregates.forEach((aggregate) => {
      const row = el("div", "metric");
      const name = el("div", "name");
      name.appendChild(document.createTextNode(aggregate.label));
      name.appendChild(
        el(
          "small",
          null,
          aggregate.n +
            " von " +
            session.repetitionCount +
            " Würfen" +
            (aggregate.cvPercent !== null ? " · VK " + nf(aggregate.cvPercent, 1) + " %" : ""),
        ),
      );
      row.appendChild(name);

      row.appendChild(buildDots(aggregate));

      const digits = digitsFor(aggregate.unit);
      const value = el("div", "value");
      value.appendChild(
        el(
          "div",
          null,
          nf(aggregate.mean, digits) + unitLabel(aggregate.unit) + " ± " + nf(aggregate.sem, digits),
        ),
      );
      value.title =
        "Streuung zwischen den Würfen: " +
        (aggregate.sd === null ? "–" : nf(aggregate.sd, digits)) +
        unitLabel(aggregate.unit) +
        " · systematischer Sockel der Methode: " +
        nf(aggregate.systematicFloor, digits) +
        unitLabel(aggregate.unit);
      row.appendChild(value);

      if (aggregate.outliers.length) {
        const note = el(
          "div",
          "note",
          "Ausreißer: " +
            aggregate.outliers
              .map((o) => "Wurf " + o.repetition + " (" + nf(o.value, digits) + ", " + nf(o.deviations, 1) + "σ)")
              .join(", "),
        );
        note.dataset.tone = "alert";
        row.appendChild(note);
      }
      host.appendChild(row);
    });

    if (!session.aggregates.length) {
      host.appendChild(el("p", "empty", "Keine Kenngröße wurde in genug Wiederholungen zuverlässig gemessen."));
    }
  }

  /**
   * Repetition-by-repetition values on a fixed scale.
   *
   * The window is set from the uncertainty of the measurement, not from the
   * spread of the values, so a steady set of serves visibly clusters and a
   * scattered one visibly does not. Normalising to the data instead would draw
   * every athlete as equally inconsistent.
   */
  function buildDots(aggregate) {
    const host = el("div", "dots");
    host.appendChild(el("div", "axis"));
    const values = aggregate.values.concat(aggregate.outliers.map((o) => o.value));
    if (!values.length) return host;

    const spread = Math.max(
      aggregate.sd === null ? 0 : aggregate.sd * 2.6,
      aggregate.systematicFloor * 2.2,
      Math.abs(aggregate.mean) * 0.02,
      1e-6,
    );
    const lo = aggregate.mean - spread;
    const hi = aggregate.mean + spread;
    const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

    const semBand = el("div", "sem");
    semBand.style.left = pos(aggregate.mean - aggregate.sem) + "%";
    semBand.style.width = Math.max(0.8, pos(aggregate.mean + aggregate.sem) - pos(aggregate.mean - aggregate.sem)) + "%";
    semBand.title = "Unsicherheit des Mittelwerts";
    host.appendChild(semBand);

    const digits = digitsFor(aggregate.unit);
    aggregate.values.forEach((value, index) => {
      const dot = el("div", "d");
      dot.style.left = pos(value) + "%";
      dot.title = "Wurf " + (index + 1) + ": " + nf(value, digits) + unitLabel(aggregate.unit);
      host.appendChild(dot);
    });
    aggregate.outliers.forEach((outlier) => {
      const dot = el("div", "d");
      dot.dataset.outlier = "true";
      dot.style.left = pos(outlier.value) + "%";
      dot.title =
        "Wurf " + outlier.repetition + " verworfen: " + nf(outlier.value, digits) + unitLabel(aggregate.unit);
      host.appendChild(dot);
    });

    const mean = el("div", "m");
    mean.style.left = pos(aggregate.mean) + "%";
    mean.title = "Mittelwert";
    host.appendChild(mean);
    return host;
  }

  /* ---------------------------------------------------------------- */
  /* Rendering: legacy, pipeline, truth                                */
  /* ---------------------------------------------------------------- */

  function renderLegacy(result, report) {
    $("legacy-score").textContent = nf(result.legacy.overall, 1);
    if (report.verdict.kind === "assessment" && typeof report.verdict.score === "number") {
      $("new-score").textContent = report.verdict.score;
      $("new-score-note").textContent = "von 100, mit Vertrauensangabe und aufgeschlüsselten Anteilen";
    } else {
      $("new-score").textContent = "—";
      $("new-score-note").textContent = "keine Zahl: die Aufnahme trägt keine Bewertung";
    }

    const rows = $("legacy-rows");
    clear(rows);
    result.legacy.rows.forEach((row) => {
      const tr = document.createElement("tr");
      const error = row.measured - row.truth;
      [
        row.label,
        nf(row.measured, 1) + "°",
        nf(row.truth, 1) + "°",
        (error >= 0 ? "+" : "") + nf(error, 1) + "°",
        nf(row.mean, 1) + " ± " + nf(row.sd, 1),
        nf(row.z, 2),
        nf(row.score, 1),
      ].forEach((text, index) => {
        const td = el("td", null, text);
        if (index === 3 && Math.abs(error) > row.sd) td.style.color = "var(--alert)";
        tr.appendChild(td);
      });
      rows.appendChild(tr);
    });

    const rigs = $("legacy-rigs");
    clear(rigs);
    result.legacy.byRig.forEach((entry) => {
      const row = el("div", "rigbar");
      row.dataset.current = String(entry.rig === result.input.rig);
      row.appendChild(el("span", null, entry.label));
      const track = el("span", "track");
      const fill = el("i");
      fill.style.width = (entry.overall / 10) * 100 + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("span", "val", nf(entry.overall, 1)));
      rigs.appendChild(row);
    });
  }

  const STATUS_TONE = { ok: "good", degraded: "warn", failed: "alert", skipped: null };

  function renderPipeline(report) {
    const host = $("layers");
    clear(host);
    const failed = report.pipeline.filter((l) => l.status !== "ok").length;
    $("pipeline-aside").textContent =
      report.pipeline.length + " Schichten · " + (failed ? failed + " eingeschränkt" : "alle in Ordnung");

    report.pipeline.forEach((layer) => {
      const row = el("div", "layer");
      row.appendChild(el("span", "id", layer.id));
      row.appendChild(el("span", null, layer.name));
      const track = el("span", "track");
      const fill = el("i");
      fill.style.width = Math.round(Math.max(0, Math.min(1, layer.quality)) * 100) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      const chip = el("span", "chip", layer.status);
      if (STATUS_TONE[layer.status]) chip.dataset.tone = STATUS_TONE[layer.status];
      row.appendChild(chip);
      if (layer.notes.length) row.appendChild(el("span", "notes", layer.notes.join(" ")));
      host.appendChild(row);
    });

    const issues = $("issues");
    clear(issues);
    report.issues.forEach((issue) => {
      const card = el("div", "card");
      card.dataset.tone = issue.severity === "blocking" ? "alert" : "warn";
      card.appendChild(el("h3", null, issue.statement));
      if (issue.evidence.length) {
        const p = el("p", null, issue.evidence.join(" · "));
        p.style.fontFamily = "var(--data)";
        p.style.fontSize = "0.74rem";
        p.style.color = "var(--ink-soft)";
        card.appendChild(p);
      }
      if (issue.checklist && issue.checklist.length) {
        const list = document.createElement("ol");
        list.style.margin = "0.4rem 0 0 1.1rem";
        list.style.fontSize = "0.8rem";
        list.style.color = "var(--ink-soft)";
        issue.checklist.forEach((step) => list.appendChild(el("li", null, step)));
        card.appendChild(list);
      }
      issues.appendChild(card);
    });
  }

  const TRUTH_LABELS = {
    kneeFlexionPeak: "Kniebeugung, Maximum",
    trunkTiltAtTrophy: "Rumpfneigung (Trophy)",
    hipShoulderSeparationPeak: "Hüft-Schulter-Trennung",
    shoulderElevationAtContact: "Schulterelevation (Kontakt)",
    elbowFlexionAtContact: "Ellbogenflexion (Kontakt)",
    contactHeightRatio: "Treffpunkthöhe / Körperhöhe",
    contactHeightM: "Treffpunkthöhe",
    contactAheadOfFrontFoot: "Treffpunkt vor dem Fuß",
    pelvisPeakLead: "Becken-Peak vor Kontakt",
    trunkPeakLead: "Rumpf-Peak vor Kontakt",
    sequenceMargin: "Abstand in der Kette",
    racketHeadPeakSpeed: "Schlägerkopfgeschwindigkeit",
  };

  function renderTruth(result, report) {
    const host = $("truth-rows");
    clear(host);
    const byId = {};
    report.metrics.forEach((m) => {
      byId[m.id] = m;
    });

    result.truth.forEach((row) => {
      const metric = byId[row.id];
      const tr = document.createElement("tr");
      const digits = digitsFor(row.unit);
      const label = TRUTH_LABELS[row.id] || (metric ? metric.label : row.id);
      const cells = [label, nf(row.truth, digits) + unitLabel(row.unit)];

      if (!metric || metric.value === null) {
        cells.push("nicht gemessen", "–", "–", "–");
        tr.appendChild(el("td", null, cells[0]));
        tr.appendChild(el("td", null, cells[1]));
        for (let i = 2; i < 6; i++) {
          const td = el("td", null, cells[i]);
          td.style.color = "var(--ink-faint)";
          tr.appendChild(td);
        }
        host.appendChild(tr);
        return;
      }

      const error = metric.value - row.truth;
      const ratio = metric.sd ? Math.abs(error) / metric.sd : null;
      const inside = metric.interval95 ? row.truth >= metric.interval95[0] && row.truth <= metric.interval95[1] : null;
      cells.push(
        nf(metric.value, digits) + unitLabel(row.unit),
        (error >= 0 ? "+" : "") + nf(error, digits),
        ratio === null ? "–" : nf(ratio, 1),
        inside === null ? "–" : inside ? "ja" : "nein",
      );
      cells.forEach((text, index) => {
        const td = el("td", null, text);
        if (index === 5) td.style.color = inside ? "var(--accent)" : "var(--alert)";
        tr.appendChild(td);
      });
      host.appendChild(tr);
    });

    const mm = result.accuracy.jointErrorMm;
    $("mpjpe-value").textContent = nf(mm, 0) + " mm";
    const mpjpeBar = $("mpjpe-bar");
    mpjpeBar.style.width = Math.max(2, Math.min(100, (1 - Math.min(1, mm / 300)) * 100)) + "%";
    mpjpeBar.dataset.level = mm < 60 ? "good" : mm < 150 ? "warn" : "alert";

    const vertical = result.accuracy.verticalConfidence;
    $("vert-value").textContent = Math.round(vertical * 100) + " %";
    const vertBar = $("vert-bar");
    vertBar.style.width = Math.round(vertical * 100) + "%";
    vertBar.dataset.level = vertical > 0.7 ? "good" : vertical > 0.4 ? "warn" : "alert";

    const mirror = result.accuracy.mirrorConfidence;
    $("mirror-value").textContent = Math.round(mirror * 100) + " %";
    const mirrorBar = $("mirror-bar");
    mirrorBar.style.width = Math.round(mirror * 100) + "%";
    mirrorBar.dataset.level = mirror > 0.7 ? "good" : mirror > 0.4 ? "warn" : "alert";
  }

  /* ---------------------------------------------------------------- */

  buildControls();
  runAnalysis();
})();
