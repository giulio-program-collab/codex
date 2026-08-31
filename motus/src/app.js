/**
 * MOTUS — der Ablauf.
 *
 * Diese Datei enthält keine Analyse. Sie ruft die sechs Schritte in ihrer
 * Reihenfolge auf und bringt das Ergebnis auf den Bildschirm. Wer wissen will,
 * *wie* MOTUS misst, liest die Dateien 01 bis 06; wer wissen will, *wann* was
 * passiert, liest diese hier.
 *
 *   01  Video      → Einzelbilder mit echten Zeitstempeln
 *   02  Bild       → 33 Körperpunkte, in Metern und im Bild
 *   03  Punkte     → dieselben, ohne Ausreißer und ohne Zittern
 *   04  Punkte     → Gelenkwinkel über die Zeit
 *   05  Winkel     → Wiederholungen
 *   06  alles      → Bericht
 */

import { loadVideo, measureFrameRate, releaseVideo, MAX_ANALYSIS_HZ } from "./01-frames.js";
import { createPoseEngine, extractPoses } from "./02-pose.js";
import { cleanTrack } from "./03-clean.js";
import { computeAngles, mostActive, LM } from "./04-angles.js";
import { findRepetitions } from "./05-reps.js";
import { buildReport, seriesToCsv } from "./06-report.js";
import { drawPose } from "./ui-overlay.js";
import { AngleChart } from "./ui-chart.js";

const $ = (id) => document.getElementById(id);
const state = {
  video: null,
  engine: null,
  raw: null,
  series: null,
  reps: null,
  report: null,
  chart: null,
  chosen: null,
  abort: null,
};

/* ------------------------------------------------------------------ */
/* Aufbau                                                              */
/* ------------------------------------------------------------------ */

export function start(assets) {
  state.assets = assets;
  state.chart = new AngleChart($("chart"));

  const drop = $("drop");
  const picker = $("file");
  drop.addEventListener("click", () => picker.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") picker.click();
  });
  picker.addEventListener("change", () => {
    if (picker.files?.[0]) analyse(picker.files[0]);
  });
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.dataset.hot = "true";
    });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.dataset.hot = "false";
    });
  }
  drop.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) analyse(file);
  });

  $("cancel").addEventListener("click", () => state.abort?.abort());
  $("again").addEventListener("click", () => picker.click());
  $("csv").addEventListener("click", () => download("motus-winkel.csv", seriesToCsv(state.series), "text/csv"));
  $("json").addEventListener("click", () =>
    download("motus-bericht.json", JSON.stringify(state.report, null, 2), "application/json"),
  );

  $("series").addEventListener("change", () => selectSeries($("series").value));

  const chart = $("chart");
  chart.addEventListener("click", (e) => {
    const t = state.chart.timeAt(e.clientX);
    if (t !== null && state.video) state.video.currentTime = t;
  });

  $("play").addEventListener("click", togglePlay);
}

/* ------------------------------------------------------------------ */
/* Der Durchlauf                                                       */
/* ------------------------------------------------------------------ */

async function analyse(file) {
  show("working");
  state.abort = new AbortController();
  status(`„${file.name}" wird geöffnet …`);

  try {
    if (state.video) releaseVideo(state.video);
    const video = await loadVideo(file);
    state.video = video;

    // --- Schritt 1 ---------------------------------------------------
    status("Bildrate wird gemessen …");
    const rate = await measureFrameRate(video);
    const hz = Math.min(rate.hz, MAX_ANALYSIS_HZ);
    const estimate = Math.round(video.duration * hz);
    status(
      `${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(1)} s, ` +
        `${rate.hz.toFixed(0)} Bilder/s${rate.measured ? " (gemessen)" : " (geschätzt)"} — ` +
        `${estimate} Bilder auszuwerten.`,
    );

    // --- Schritt 2 ---------------------------------------------------
    if (!state.engine) {
      status("Das Bewegungsmodell wird geladen … (einmalig)");
      state.engine = await createPoseEngine(state.assets);
    }

    const t0 = performance.now();
    const { frames, missed } = await extractPoses(video, state.engine, {
      hz,
      signal: state.abort.signal,
      onProgress: (frac, done, total) => {
        $("bar").style.width = (frac * 100).toFixed(1) + "%";
        const perFrame = (performance.now() - t0) / Math.max(1, done);
        const left = ((total - done) * perFrame) / 1000;
        $("count").textContent = `Bild ${done} von ${total} · noch ca. ${Math.ceil(left)} s`;
      },
    });

    if (state.abort.signal.aborted) {
      show("intro");
      return;
    }
    if (frames.length < 8) {
      throw new Error("Das Video ist zu kurz für eine Auswertung — mindestens eine Sekunde wird gebraucht.");
    }
    if (missed === frames.length) {
      throw new Error(
        "In keinem einzigen Bild wurde eine Person gefunden. Meist liegt es daran, dass die " +
          "Person zu klein im Bild ist — sie sollte mindestens die halbe Bildhöhe ausfüllen.",
      );
    }

    // --- Schritte 3 bis 6 -------------------------------------------
    status("Wird ausgewertet …");
    await tick();
    const cleaned = cleanTrack(frames);
    const series = computeAngles(cleaned.frames);
    const lead = mostActive(series) ?? series[0];
    const reps = findRepetitions(lead);
    const report = buildReport(series, { ...reps, seriesId: lead.id }, {
      fps: hz,
      duration: video.duration,
      frameCount: frames.length,
      sourceName: file.name,
    });

    if (rate.note) report.caveats.unshift({ id: "cadence", text: rate.note, remedy: "Ohne Not nicht als Zeitlupe exportieren; die Originaldatei ist besser." });
    if (missed > 0) {
      report.caveats.push({
        id: "missing",
        text: `In ${missed} von ${frames.length} Bildern war keine Person zu sehen.`,
        remedy: "Den Ausschnitt so wählen, dass die Person durchgehend vollständig im Bild ist.",
      });
    }

    state.raw = cleaned.frames.map((f, i) => ({ ...f, image: frames[i].image }));
    state.series = series;
    state.reps = reps;
    state.report = report;
    window.__report = report; // fuer Prueflaeufe und die Konsole
    render(lead.id);
    show("result");
    // Erst nach `show` messen: In einem versteckten Element ist die Breite
    // null, und das Overlay bekäme einen Canvas der Größe null.
    requestAnimationFrame(() => {
      state.overlay.width = $("stage").clientWidth;
      state.overlay.height = $("stage").clientHeight;
      syncToVideo();
    });
  } catch (err) {
    $("error-text").textContent = err.message;
    show("error");
  }
}

/* ------------------------------------------------------------------ */
/* Anzeige                                                             */
/* ------------------------------------------------------------------ */

function render(leadId) {
  const { report, series, video } = state;

  // Video mit Overlay
  const holder = $("stage");
  holder.innerHTML = "";
  video.controls = false;
  video.classList.add("player");
  holder.appendChild(video);
  const overlay = document.createElement("canvas");
  overlay.className = "overlay";
  holder.appendChild(overlay);
  state.overlay = overlay;

  const sizeOverlay = () => {
    overlay.width = holder.clientWidth;
    overlay.height = holder.clientHeight;
  };
  new ResizeObserver(sizeOverlay).observe(holder);
  sizeOverlay();

  video.addEventListener("timeupdate", syncToVideo);
  video.addEventListener("seeked", syncToVideo);
  video.addEventListener("play", () => ($("play").textContent = "Pause"));
  video.addEventListener("pause", () => ($("play").textContent = "Abspielen"));
  video.currentTime = 0;
  loop();

  // Kopfzahlen
  $("k-reps").textContent = report.reps.count || "—";
  $("k-duration").textContent = report.reps.meanDuration ? report.reps.meanDuration.toFixed(2) + " s" : "—";
  $("k-frames").textContent = `${report.video.analysedFrames} @ ${Math.round(report.video.sampleHz)} Hz`;
  $("k-source").textContent = report.source ?? "—";

  // Auswahl der Reihe
  const select = $("series");
  select.innerHTML = "";
  for (const s of series) {
    if (s.coverage < 0.2) continue;
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.label} · ${s.range.toFixed(0)}° Spannweite`;
    select.appendChild(opt);
  }
  select.value = leadId;
  selectSeries(leadId);

  renderJoints(report);
  renderReps(report);
  renderCaveats(report);
}

function selectSeries(id) {
  const s = state.series.find((x) => x.id === id);
  if (!s) return;
  state.chosen = s;
  const reps = findRepetitions(s);
  state.chart.setData(s, reps.reps);
  $("counted-on").textContent =
    reps.reps.length > 0
      ? `${reps.reps.length} Wiederholungen, gezählt an: ${s.label}`
      : `Keine Wiederholungen erkennbar an: ${s.label}`;
}

function renderJoints(report) {
  const host = $("joints");
  host.innerHTML = "";
  for (const j of report.joints) {
    if (j.range === null) continue;
    const row = document.createElement("tr");
    row.dataset.reliable = String(j.reliable);
    const flags = [];
    if (j.coverage < 0.7) flags.push(`nur ${Math.round(j.coverage * 100)} % messbar`);
    if (j.depthShare > 0.6) flags.push("perspektivisch heikel");
    if (j.meanConfidence < 0.6) flags.push("schwach erkannt");
    row.innerHTML = `
      <td>${j.label}${flags.length ? `<small>${flags.join(" · ")}</small>` : ""}</td>
      <td class="num">${fmt(j.min)}</td>
      <td class="num">${fmt(j.max)}</td>
      <td class="num strong">${fmt(j.range)}</td>
      <td class="num">${j.consistency ? "± " + fmt(j.consistency.sd) : "—"}</td>
      <td class="num">${
        j.consistency?.driftIsReal
          ? `<span class="${j.consistency.driftPerRep < 0 ? "down" : "up"}">${
              j.consistency.driftPerRep > 0 ? "+" : ""
            }${fmt(j.consistency.driftPerRep)}/Wdh.</span>`
          : "—"
      }</td>`;
    host.appendChild(row);
  }
}

function renderReps(report) {
  const host = $("reps");
  const panel = $("reps-panel");
  host.innerHTML = "";
  if (!report.reps.count) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  for (const r of report.reps.list) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="num">${r.index}${r.truncated ? '<small title="reicht über den Rand des Videos hinaus">Rand</small>' : ""}</td>
      <td class="num">${r.tStart.toFixed(2)} s</td>
      <td class="num">${r.duration.toFixed(2)} s</td>
      <td class="num strong">${fmt(r.extreme)}</td>
      <td class="num">${fmt(r.amplitude)}</td>`;
    row.addEventListener("click", () => {
      if (state.video) state.video.currentTime = r.tStart;
    });
    host.appendChild(row);
  }
  const s = report.reps;
  const timedNote = s.timedOn < s.count ? ` (aus ${s.timedOn} vollständigen von ${s.count})` : "";
  $("rep-summary").textContent =
    `Im Mittel ${s.meanDuration.toFixed(2)} s pro Wiederholung (± ${s.durationSd.toFixed(2)} s)${timedNote}` +
    (s.cadence ? `, das sind ${s.cadence.toFixed(0)} pro Minute.` : ".") +
    (s.slowing !== null && Math.abs(s.slowing) > 0.02
      ? ` Die Bewegung wird im Verlauf ${s.slowing > 0 ? "langsamer" : "schneller"} ` +
        `(${s.slowing > 0 ? "+" : ""}${(s.slowing * 1000).toFixed(0)} ms pro Wiederholung).`
      : "");
}

function renderCaveats(report) {
  const host = $("caveats");
  host.innerHTML = "";
  if (!report.caveats.length) {
    // Nicht „alles in Ordnung" behaupten, sondern sagen, was geprüft wurde.
    // MOTUS kann vier Dinge prüfen; es kann nicht wissen, ob ein fünftes,
    // ungeprüftes Problem vorliegt — und ein Satz, der das offenlässt, ist
    // nicht schwächer, sondern richtig.
    const worst = (pick, better = Math.min) =>
      report.joints.length ? better(...report.joints.map(pick)) : null;
    host.innerHTML = `
      <p class="good">Die vier Prüfungen, die MOTUS durchführt, sind alle bestanden:</p>
      <ul class="checks">
        <li>In mindestens ${Math.round(worst((j) => j.coverage) * 100)} % der Bilder war jedes
            gemessene Gelenk bestimmbar.</li>
        <li>Die Erkennung lag im Mittel nirgends unter
            ${Math.round(worst((j) => j.meanConfidence) * 100)} %.</li>
        <li>Kein Gelenk zeigte überwiegend auf die Kamera zu (schlechtester Tiefenanteil
            ${Math.round(worst((j) => j.depthShare, Math.max) * 100)} %).</li>
        <li>Die Verfolgung ist nirgends abgerissen.</li>
      </ul>
      <p class="good">Was MOTUS <em>nicht</em> geprüft hat: ob die gefilmte Bewegung die
         beabsichtigte war, ob die Kamera stillstand und ob die Person diejenige ist,
         um die es geht.</p>`;
    return;
  }
  for (const c of report.caveats) {
    const card = document.createElement("div");
    card.className = "caveat";
    card.innerHTML = `<p>${c.text}</p><p class="remedy">${c.remedy}</p>`;
    host.appendChild(card);
  }
}

/* ------------------------------------------------------------------ */
/* Wiedergabe                                                          */
/* ------------------------------------------------------------------ */

function syncToVideo() {
  if (!state.video || !state.raw) return;
  const t = state.video.currentTime;
  state.chart.setCursor(t);
  const i = nearestFrame(t);
  const highlight = state.chosen ? LM[state.chosen.at ?? state.chosen.id] ?? null : null;
  drawPose(
    state.overlay.getContext("2d"),
    state.raw[i],
    state.overlay.width,
    state.overlay.height,
    { highlight },
  );
  $("time").textContent = t.toFixed(2) + " s";
}

function loop() {
  if (state.video && !state.video.paused) syncToVideo();
  requestAnimationFrame(loop);
}

function nearestFrame(t) {
  const frames = state.raw;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].t - t) < Math.abs(frames[lo].t - t)) return lo - 1;
  return lo;
}

function togglePlay() {
  if (!state.video) return;
  if (state.video.paused) state.video.play();
  else state.video.pause();
}

/* ------------------------------------------------------------------ */
/* Kleinkram                                                           */
/* ------------------------------------------------------------------ */

const fmt = (x) => (x === null || x === undefined ? "—" : `${x.toFixed(1)}°`);

function show(which) {
  for (const id of ["intro", "working", "result", "error"]) {
    $(id).hidden = id !== which;
  }
}

function status(text) {
  $("status").textContent = text;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
