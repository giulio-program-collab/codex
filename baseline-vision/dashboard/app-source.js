/* ------------------------------------------------------------------ */
/* Baseline Vision — coach dashboard                                   */
/*                                                                     */
/* Everything on this page is rendered from the engine's own report.   */
/* There is no sample data and no placeholder text: if a panel is      */
/* empty it is because the analysis produced nothing for it, which is  */
/* itself the answer a coach needs.                                    */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children))
    if (c)
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
};
const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
};
const pct = (x) => Math.round(x * 100);
const num = (x, d = 1) => (x === null || x === undefined ? "—" : x.toFixed(d));

/** Confidence bands, kept identical to the engine's own thresholds. */
function bandClass(c) {
  return c >= 0.8 ? "ok" : c >= 0.6 ? "warn" : "bad";
}
function statusClass(s) {
  return s === "ok"
    ? "ok"
    : s === "degraded"
      ? "warn"
      : s === "failed"
        ? "bad"
        : "";
}

/* ------------------------------------------------------------------ */
/* Per-coach decisions on findings                                     */
/* ------------------------------------------------------------------ */

/**
 * The coach's verdict on each AI finding, kept in this browser only.
 * The system proposes; the coach disposes. A recommendation the coach has
 * rejected stays visible with that rejection attached, because the fact that a
 * finding keeps reappearing and keeps being rejected is information too.
 */
const decisions = {
  key: "baseline-vision:decisions",
  all() {
    try {
      return JSON.parse(localStorage.getItem(this.key) || "{}");
    } catch {
      return {};
    }
  },
  get(caseId, findingId) {
    return this.all()[caseId + "/" + findingId] || null;
  },
  set(caseId, findingId, value) {
    try {
      const all = this.all();
      if (value) all[caseId + "/" + findingId] = value;
      else delete all[caseId + "/" + findingId];
      localStorage.setItem(this.key, JSON.stringify(all));
    } catch {
      /* private window, blocked storage: the page still works */
    }
  },
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  caseIndex: 0,
  frame: 0,
  playing: false,
  speed: 0.25,
  showDetected: true,
  showReconstruction: true,
  azimuth: 35,
  elevation: 18,
  compareA: 0,
  compareB: 1,
  comparePhase: "contact",
};

const current = () => DATA.cases[state.caseIndex];

/* ------------------------------------------------------------------ */
/* Rail                                                                */
/* ------------------------------------------------------------------ */

function renderCases() {
  const host = $("cases");
  clear(host);
  DATA.cases.forEach((c, i) => {
    const v = c.report.verdict;
    const label =
      v.kind === "assessment"
        ? "Score " + v.score + " · Qualität " + c.report.quality.overall
        : "keine Bewertung · Qualität " + c.report.quality.overall;
    host.appendChild(
      el(
        "button",
        {
          "class": "case-btn",
          "aria-current": String(i === state.caseIndex),
          "onclick": () => {
            state.caseIndex = i;
            state.frame = 0;
            state.playing = false;
            render();
          },
        },
        [c.title, el("em", { text: label })],
      ),
    );
  });
}

/* ------------------------------------------------------------------ */
/* Verdict                                                             */
/* ------------------------------------------------------------------ */

function renderVerdict() {
  const c = current();
  const v = c.report.verdict;
  const host = $("verdict");
  clear(host);

  const card = el("div", {
    class: "card verdict" + (v.kind === "assessment" ? "" : " blocked"),
  });
  card.appendChild(el("h3", { text: v.statement }));

  if (v.kind === "assessment") {
    card.appendChild(
      el("div", { class: "score-row" }, [
        el("span", { class: "score-big", text: String(v.score) }),
        el("span", { class: "sub", text: "/ 100" }),
        el("span", {
          class: "chip " + bandClass(v.confidence || 0),
          text: "Sicherheit " + pct(v.confidence || 0) + " %",
        }),
      ]),
    );
    card.appendChild(
      el("p", {
        text:
          "Die Zahl ist eine Zusammenfassung der Komponenten darunter, nicht die Wahrheit über den " +
          "Schlag. Jede Komponente ist auf benannte Messgrößen zurückführbar.",
      }),
    );
    const labelFor = (id) => {
      const m = c.report.metrics.find((x) => x.id === id);
      return (m && m.label) || id;
    };
    for (const comp of v.components || []) {
      card.appendChild(
        el("div", { class: "meter" }, [
          el("div", {}, [comp.label]),
          el("div", { class: "bar" }, [
            el("i", { style: "width:" + comp.score + "%" }),
          ]),
          el("div", {
            class: "num",
            text: comp.score + " · " + pct(comp.weight) + "%",
          }),
          el("div", {
            class: "remedy",
            text: "aus: " + comp.basedOn.map(labelFor).join(", "),
          }),
        ]),
      );
    }
  }

  if (v.reasons && v.reasons.length) {
    card.appendChild(
      el("div", {
        class: "sub",
        style: "margin:12px 0 6px",
        text: "Begründung",
      }),
    );
    card.appendChild(
      el(
        "ul",
        { class: "reasons" },
        v.reasons.map((r) => el("li", { text: r })),
      ),
    );
  }
  host.appendChild(card);

  const issues = c.report.issues || [];
  if (issues.length) {
    const box = el("div", { class: "card" });
    box.appendChild(
      el("div", { class: "eyebrow", text: "Plausibilitätsprüfung" }),
    );
    for (const issue of issues) {
      box.appendChild(
        el("div", { style: "margin-top:12px" }, [
          el(
            "div",
            {
              style: "display:flex;gap:8px;align-items:baseline;flex-wrap:wrap",
            },
            [
              el("span", {
                class:
                  "chip " + (issue.severity === "blocking" ? "bad" : "warn"),
                text: issue.severity === "blocking" ? "blockierend" : "Hinweis",
              }),
              el("span", { style: "font-size:13.5px", text: issue.statement }),
            ],
          ),
          issue.evidence && issue.evidence.length
            ? el(
                "ul",
                { class: "reasons", style: "margin-top:6px" },
                issue.evidence.map((e) => el("li", { text: e })),
              )
            : null,
          issue.checklist && issue.checklist.length
            ? el("div", {
                class: "note",
                text: "Zu prüfen: " + issue.checklist.join(" → "),
              })
            : null,
        ]),
      );
    }
    host.appendChild(box);
  }
}

/* ------------------------------------------------------------------ */
/* Quality                                                             */
/* ------------------------------------------------------------------ */

function renderQuality() {
  const q = current().report.quality;
  const host = $("quality");
  clear(host);
  const card = el("div", { class: "card" });
  card.appendChild(
    el("div", { class: "score-row" }, [
      el("span", { class: "score-big", text: String(q.overall) }),
      el("span", { class: "sub", text: "/ 100" }),
      el("span", {
        class: "chip " + (q.verdictAllowed ? "ok" : "warn"),
        text: q.verdictAllowed ? "Bewertung zulässig" : "Bewertung gesperrt",
      }),
    ]),
  );
  for (const comp of q.components) {
    card.appendChild(
      el("div", { class: "meter" }, [
        el("div", { text: comp.label }),
        el("div", { class: "bar" }, [
          el("i", {
            style:
              "width:" +
              comp.score +
              "%;background:" +
              (comp.score >= 75
                ? "var(--jade)"
                : comp.score >= 50
                  ? "var(--straw)"
                  : "var(--rose)"),
          }),
        ]),
        el("div", { class: "num", text: comp.score + " %" }),
        comp.score < 75 && comp.remedy
          ? el("div", { class: "remedy", text: "→ " + comp.remedy })
          : null,
      ]),
    );
  }
  if (q.blockers && q.blockers.length) {
    card.appendChild(
      el("div", {
        class: "sub",
        style: "margin-top:14px",
        text: "Blockierend",
      }),
    );
    card.appendChild(
      el(
        "ul",
        { class: "reasons" },
        q.blockers.map((b) => el("li", { text: b })),
      ),
    );
  }
  host.appendChild(card);
}

/* ------------------------------------------------------------------ */
/* Overlay                                                             */
/* ------------------------------------------------------------------ */

const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs))
    if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  return n;
};

function drawSkeleton(g, points, colour, width, opacity) {
  for (const [a, b] of DATA.bones) {
    const p = points[a],
      q = points[b];
    if (!p || !q) continue;
    g.appendChild(
      svgEl("line", {
        "x1": p[0],
        "y1": p[1],
        "x2": q[0],
        "y2": q[1],
        "stroke": colour,
        "stroke-width": width,
        "stroke-linecap": "round",
        opacity,
      }),
    );
  }
  for (const p of points) {
    if (!p) continue;
    g.appendChild(
      svgEl("circle", {
        cx: p[0],
        cy: p[1],
        r: width * 1.4,
        fill: colour,
        opacity,
      }),
    );
  }
}

function renderStage(host, caseData, frameIndex, opts) {
  const f =
    caseData.overlay[
      Math.max(0, Math.min(caseData.overlay.length - 1, Math.round(frameIndex)))
    ];
  // Cropped to the action, not to the full sensor: a coach filming from the
  // fence leaves the player in a small part of the frame, and reproducing that
  // framing here would waste the panel on empty court.
  const [cx, cy, cw, ch] = caseData.crop;
  const svg = svgEl("svg", {
    viewBox: cx + " " + cy + " " + cw + " " + ch,
    preserveAspectRatio: "xMidYMid meet",
  });
  svg.appendChild(
    svgEl("rect", { x: cx, y: cy, width: cw, height: ch, fill: "#0F0B09" }),
  );

  // Motion trail of the racket head: the single most useful overlay for a
  // serve, and the one a coach can read at a glance.
  const trail = svgEl("path", {
    "fill": "none",
    "stroke": "var(--straw)",
    "stroke-width": 3,
    "opacity": 0.35,
  });
  let d = "";
  const trailFrames = Math.round(caseData.report.video.fps * 0.4);
  for (
    let i = Math.max(0, Math.round(frameIndex) - trailFrames);
    i <= Math.round(frameIndex);
    i++
  ) {
    const r = caseData.overlay[i] && caseData.overlay[i].racket;
    if (!r) continue;
    d += (d ? " L" : "M") + r[2] + " " + r[3];
  }
  if (d) {
    trail.setAttribute("d", d);
    svg.appendChild(trail);
  }

  const g = svgEl("g", {});
  if (opts.showDetected !== false) drawSkeleton(g, f.d, "#7C8AA0", 4, 0.55);
  if (opts.showReconstruction !== false)
    drawSkeleton(g, f.r, "var(--clay)", 5, 0.95);
  if (f.racket) {
    g.appendChild(
      svgEl("line", {
        "x1": f.racket[0],
        "y1": f.racket[1],
        "x2": f.racket[2],
        "y2": f.racket[3],
        "stroke": "var(--straw)",
        "stroke-width": 6,
        "stroke-linecap": "round",
      }),
    );
    g.appendChild(
      svgEl("circle", {
        "cx": f.racket[2],
        "cy": f.racket[3],
        "r": 12,
        "fill": "none",
        "stroke": "var(--straw)",
        "stroke-width": 3,
      }),
    );
  }
  if (f.ball)
    g.appendChild(
      svgEl("circle", { cx: f.ball[0], cy: f.ball[1], r: 9, fill: "#F2E9A0" }),
    );
  svg.appendChild(g);

  const stage = el("div", { class: "stage" });
  stage.appendChild(svg);
  host.appendChild(stage);
  return svg;
}

function phaseAt(caseData, frameIndex) {
  return (
    (caseData.report.phases || []).find(
      (p) => frameIndex >= p.startFrame && frameIndex < p.endFrame,
    ) || null
  );
}

const PHASE_COLOURS = [
  "#2E2621",
  "#39302A",
  "#453A31",
  "#4E4138",
  "#5A4A3E",
  "#6B5644",
  "#C1734F",
  "#4E4138",
  "#39302A",
];

function renderTimeline(host, caseData, onSeek) {
  const total = caseData.overlay.length;
  const phases = caseData.report.phases || [];
  const wrap = el("div", { class: "timeline" });
  const bar = el("div", { class: "phases" });
  phases.forEach((p, i) => {
    const width = ((p.endFrame - p.startFrame) / total) * 100;
    bar.appendChild(
      el(
        "div",
        {
          style:
            "width:" +
            width +
            "%;background:" +
            PHASE_COLOURS[i % PHASE_COLOURS.length] +
            ";opacity:" +
            (0.55 + 0.45 * p.confidence),
          title: p.label + " · Sicherheit " + pct(p.confidence) + " %",
          onclick: () => onSeek(p.startFrame),
        },
        [width > 6 ? p.label : ""],
      ),
    );
  });
  wrap.appendChild(bar);
  host.appendChild(wrap);
}

function renderPlayer() {
  const c = current();
  const host = $("player");
  clear(host);
  const card = el("div", { class: "card" });

  const stageHost = el("div", {});
  card.appendChild(stageHost);
  renderStage(stageHost, c, state.frame, state);

  card.appendChild(
    el("div", { class: "legend" }, [
      el("span", {}, [
        el("i", { style: "background:#7C8AA0" }),
        "erkannte 2D-Gelenke",
      ]),
      el("span", {}, [
        el("i", { style: "background:var(--clay)" }),
        "3D-Rekonstruktion, zurückprojiziert",
      ]),
      el("span", {}, [
        el("i", { style: "background:var(--straw)" }),
        "Schläger und Schlägerkopfbahn",
      ]),
      el("span", {
        class: "sub",
        text: "Weichen beide Skelette voneinander ab, passt die Rekonstruktion nicht zum Bild.",
      }),
    ]),
  );

  renderTimeline(card, c, (f) => {
    state.frame = f;
    state.playing = false;
    renderPlayer();
    render3D();
  });

  const fps = c.report.video.fps;
  const phase = phaseAt(c, state.frame);
  const contact = c.report.contactFrame;
  const label = el("div", {
    class: "frame-label",
    text:
      "Bild " +
      Math.round(state.frame) +
      " / " +
      (c.overlay.length - 1) +
      "  ·  " +
      (state.frame / fps).toFixed(3) +
      " s" +
      (contact !== null
        ? "  ·  Kontakt " +
          (((state.frame - contact) / fps) * 1000).toFixed(0) +
          " ms"
        : ""),
  });

  const seek = el("input", {
    type: "range",
    min: 0,
    max: c.overlay.length - 1,
    step: 1,
    value: Math.round(state.frame),
    oninput: (e) => {
      state.frame = Number(e.target.value);
      state.playing = false;
      renderPlayer();
      render3D();
    },
  });

  const step = (delta) => {
    state.playing = false;
    state.frame = Math.max(
      0,
      Math.min(c.overlay.length - 1, state.frame + delta),
    );
    renderPlayer();
    render3D();
  };

  const controls = el("div", { class: "controls" }, [
    el("button", {
      class: "ctl",
      text: state.playing ? "⏸ Pause" : "▶ Abspielen",
      onclick: () => {
        state.playing = !state.playing;
        renderPlayer();
        if (state.playing) tick();
      },
    }),
    el("button", { class: "ctl", text: "◀ Bild", onclick: () => step(-1) }),
    el("button", { class: "ctl", text: "Bild ▶", onclick: () => step(1) }),
    ...[0.1, 0.25, 0.5, 1].map((s) =>
      el("button", {
        "class": "ctl",
        "aria-pressed": String(state.speed === s),
        "text": s + "×",
        "onclick": () => {
          state.speed = s;
          renderPlayer();
        },
      }),
    ),
    el("button", {
      "class": "ctl",
      "aria-pressed": String(state.showDetected),
      "text": "2D",
      "onclick": () => {
        state.showDetected = !state.showDetected;
        renderPlayer();
      },
    }),
    el("button", {
      "class": "ctl",
      "aria-pressed": String(state.showReconstruction),
      "text": "3D",
      "onclick": () => {
        state.showReconstruction = !state.showReconstruction;
        renderPlayer();
      },
    }),
  ]);

  card.appendChild(el("div", { class: "controls" }, [seek]));
  card.appendChild(controls);
  card.appendChild(
    el("div", { class: "controls" }, [
      label,
      phase
        ? el("span", {
            class: "chip " + bandClass(phase.confidence),
            text: phase.label + " · " + pct(phase.confidence) + " %",
          })
        : null,
      c.report.contactFrame !== null
        ? el("span", {
            class: "chip " + bandClass(c.report.contactConfidence),
            text: "Treffpunkt " + pct(c.report.contactConfidence) + " %",
          })
        : el("span", { class: "chip bad", text: "kein Treffpunkt bestimmbar" }),
    ]),
  );

  host.appendChild(card);
}

let rafHandle = null;
let lastStamp = 0;
function tick(stamp) {
  if (!state.playing) {
    rafHandle = null;
    return;
  }
  if (!lastStamp) lastStamp = stamp || 0;
  const dt = ((stamp || 0) - lastStamp) / 1000;
  lastStamp = stamp || 0;
  const c = current();
  state.frame += dt * c.report.video.fps * state.speed;
  if (state.frame >= c.overlay.length - 1) {
    state.frame = 0;
  }
  renderPlayer();
  render3D();
  rafHandle = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ */
/* 3D view                                                             */
/* ------------------------------------------------------------------ */

function render3D() {
  const c = current();
  const host = $("threed");
  const existing = host.querySelector("svg");
  const frame =
    c.overlay[
      Math.max(0, Math.min(c.overlay.length - 1, Math.round(state.frame)))
    ];

  const size = 420;
  const az = (state.azimuth * Math.PI) / 180;
  const elv = (state.elevation * Math.PI) / 180;
  const project = (p) => {
    // Orthographic: rotate about the court's vertical, then tilt.
    const x = p[0] * Math.cos(az) - p[1] * Math.sin(az);
    const y = p[0] * Math.sin(az) + p[1] * Math.cos(az);
    const sx = x;
    const sy = p[2] * Math.cos(elv) - y * Math.sin(elv);
    return [size / 2 + sx * 90, size - 40 - sy * 90];
  };

  const svg = svgEl("svg", {
    viewBox: "0 0 " + size + " " + size,
    style: "touch-action:none;cursor:grab",
  });
  svg.appendChild(
    svgEl("rect", { x: 0, y: 0, width: size, height: size, fill: "#0F0B09" }),
  );

  // Court grid, so rotation is legible.
  for (let i = -2; i <= 2; i++) {
    const a = project([i * 0.5, -1.5, 0]);
    const b = project([i * 0.5, 1.5, 0]);
    const cc = project([-1, i * 0.75, 0]);
    const dd = project([1, i * 0.75, 0]);
    svg.appendChild(
      svgEl("line", {
        "x1": a[0],
        "y1": a[1],
        "x2": b[0],
        "y2": b[1],
        "stroke": "#2A221C",
        "stroke-width": 1,
      }),
    );
    svg.appendChild(
      svgEl("line", {
        "x1": cc[0],
        "y1": cc[1],
        "x2": dd[0],
        "y2": dd[1],
        "stroke": "#2A221C",
        "stroke-width": 1,
      }),
    );
  }

  const pts = frame.p.map((p) => (p ? project(p) : null));
  drawSkeleton(svg, pts, "var(--clay)", 3, 1);
  if (frame.p) {
    const handIndex = DATA.joints.indexOf(
      c.report.player.hand === "right" ? "handR" : "handL",
    );
    const hand = frame.p[handIndex];
    if (hand) {
      const h = project(hand);
      svg.appendChild(
        svgEl("circle", { cx: h[0], cy: h[1], r: 4, fill: "var(--straw)" }),
      );
    }
  }

  if (existing) {
    existing.replaceWith(svg);
    attachDrag(svg);
    return;
  }

  clear(host);
  const card = el("div", { class: "card" });
  const stage = el("div", { class: "stage", style: "max-width:460px" });
  stage.appendChild(svg);
  card.appendChild(stage);
  card.appendChild(
    el("div", { class: "legend" }, [
      el("span", {
        class: "sub",
        text:
          "Ziehen zum Drehen. Die Darstellung zeigt die rekonstruierten 3D-Positionen " +
          "im Platzsystem — nicht das Videobild.",
      }),
    ]),
  );
  card.appendChild(
    el("div", { class: "controls" }, [
      el("button", {
        class: "ctl",
        text: "Seitlich",
        onclick: () => {
          state.azimuth = 0;
          state.elevation = 10;
          render3D();
        },
      }),
      el("button", {
        class: "ctl",
        text: "Von hinten",
        onclick: () => {
          state.azimuth = 90;
          state.elevation = 10;
          render3D();
        },
      }),
      el("button", {
        class: "ctl",
        text: "Von oben",
        onclick: () => {
          state.azimuth = 35;
          state.elevation = 75;
          render3D();
        },
      }),
    ]),
  );
  host.appendChild(card);
  attachDrag(svg);
}

function attachDrag(svg) {
  let dragging = false,
    lastX = 0,
    lastY = 0;
  svg.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    state.azimuth = (state.azimuth + (e.clientX - lastX) * 0.6) % 360;
    state.elevation = Math.max(
      -85,
      Math.min(85, state.elevation + (e.clientY - lastY) * 0.4),
    );
    lastX = e.clientX;
    lastY = e.clientY;
    render3D();
  });
  svg.addEventListener("pointerup", () => {
    dragging = false;
  });
  svg.addEventListener("pointercancel", () => {
    dragging = false;
  });
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

const OBSERVABILITY = {
  direct: ["direkt", "ok"],
  reconstructed: ["rekonstruiert", ""],
  depth_limited: ["tiefenlimitiert", "warn"],
  unobservable: ["nicht beobachtbar", "bad"],
};

function renderMetrics() {
  const c = current();
  const host = $("metrics");
  clear(host);

  const card = el("div", { class: "card" });
  const table = el("table");
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Kenngröße" }),
        el("th", { text: "Phase" }),
        el("th", { text: "Messwert" }),
        el("th", { text: "Sicherheit" }),
        el("th", { text: "Beobachtbarkeit" }),
        el("th", { text: "Referenz" }),
      ]),
    ]),
  );
  const body = el("tbody");

  for (const m of c.report.metrics) {
    const row = el("tr", { class: m.rejected ? "rejected" : "" });
    const nameCell = el("td", {}, [el("div", { text: m.label })]);
    if (m.notes.length) {
      const note = el("div", {
        class: "note",
        style: "display:none",
        text:
          m.notes.join(" ") +
          (m.rejectionReason ? " " + m.rejectionReason : ""),
      });
      nameCell.appendChild(
        el("button", {
          class: "expand",
          text: "Hinweise (" + m.notes.length + ")",
          onclick: (e) => {
            const open = note.style.display === "none";
            note.style.display = open ? "block" : "none";
            e.target.textContent = open
              ? "Hinweise ausblenden"
              : "Hinweise (" + m.notes.length + ")";
          },
        }),
      );
      nameCell.appendChild(note);
    }
    row.appendChild(nameCell);
    row.appendChild(el("td", { class: "sub", text: m.phase }));
    row.appendChild(
      el("td", {}, [
        el("div", { class: "val", text: m.formatted }),
        m.interval95
          ? el("div", {
              class: "note",
              text:
                "95 %: " +
                num(m.interval95[0], 2) +
                " … " +
                num(m.interval95[1], 2),
            })
          : null,
      ]),
    );
    row.appendChild(
      el("td", {}, [
        el("span", {
          class: "chip " + bandClass(m.confidence),
          text: pct(m.confidence) + " % " + m.confidenceLabel,
        }),
      ]),
    );
    const obs = OBSERVABILITY[m.observability] || [m.observability, ""];
    row.appendChild(
      el("td", {}, [el("span", { class: "chip " + obs[1], text: obs[0] })]),
    );
    row.appendChild(
      el(
        "td",
        {},
        m.reference
          ? [
              el("div", { class: "val", text: m.reference.deviation }),
              el("div", {
                class: "note",
                text:
                  "Referenz " +
                  num(m.reference.mean, 2) +
                  " ± " +
                  num(m.reference.combinedSd, 2) +
                  (m.reference.z !== null
                    ? " · z = " + num(m.reference.z, 2)
                    : ""),
              }),
              m.reference.cohortReasons.length
                ? el("div", {
                    class: "note",
                    text: m.reference.cohortReasons.join(" "),
                  })
                : null,
            ]
          : [el("span", { class: "sub", text: "nur Eigenvergleich" })],
      ),
    );
    body.appendChild(row);
  }
  table.appendChild(body);
  card.appendChild(table);
  host.appendChild(card);

  if (c.report.notMeasurable.length) {
    const box = el("div", { class: "card" });
    box.appendChild(el("div", { class: "eyebrow", text: "Nicht messbar" }));
    box.appendChild(
      el("p", {
        class: "sub",
        style: "margin:6px 0 10px",
        text: "Diese Größen werden bewusst nicht geschätzt. Der Grund steht dabei.",
      }),
    );
    for (const nm of c.report.notMeasurable) {
      box.appendChild(
        el(
          "div",
          { style: "padding:8px 0;border-bottom:1px solid var(--border-soft)" },
          [
            el("div", { style: "font-size:13px", text: nm.label }),
            el("div", { class: "note", text: nm.reason }),
          ],
        ),
      );
    }
    host.appendChild(box);
  }
}

/* ------------------------------------------------------------------ */
/* Findings                                                            */
/* ------------------------------------------------------------------ */

function renderFindings() {
  const c = current();
  const host = $("findings");
  clear(host);
  const card = el("div", { class: "card" });

  if (!c.report.findings.length) {
    card.appendChild(
      el("p", {
        class: "empty",
        text:
          "Keine Befunde. Entweder war nichts auffällig, oder die Datenlage trug keine Aussage — " +
          "welches von beidem, steht unter „Analysequalität“.",
      }),
    );
    host.appendChild(card);
    return;
  }

  c.report.findings.forEach((f, i) => {
    const box = el("div", { class: "finding" });
    box.appendChild(
      el("div", { class: "finding-head" }, [
        el("h4", { text: i + 1 + ". " + firstSentence(f.observation) }),
        el("span", {
          class: "chip " + bandClass(f.confidence),
          text: "Sicherheit " + pct(f.confidence) + " % · " + f.confidenceLabel,
        }),
      ]),
    );
    const dl = el("dl", { style: "margin:6px 0 0" });
    const add = (term, text) => {
      dl.appendChild(el("dt", { text: term }));
      dl.appendChild(el("dd", { text }));
    };
    add("Beobachtung", f.observation);
    add("Interpretation", f.interpretation);
    add("Konsequenz", f.consequence);
    add("Empfehlung", f.recommendation);
    box.appendChild(dl);

    const stored = decisions.get(c.id, f.id) || {};
    const commentBox = el("textarea", {
      placeholder: "Kommentar des Trainers …",
    });
    commentBox.value = stored.comment || "";
    const statusChip = el("span", {
      class: "chip",
      text: stored.status ? statusLabel(stored.status) : "offen",
    });
    const mark = (status) => {
      const next = { status, comment: commentBox.value };
      decisions.set(c.id, f.id, next);
      statusChip.textContent = statusLabel(status);
      statusChip.className =
        "chip " +
        (status === "accepted" ? "ok" : status === "rejected" ? "bad" : "warn");
    };
    box.appendChild(
      el("div", { class: "decide" }, [
        el("button", {
          class: "ctl",
          text: "Übernehmen",
          onclick: () => mark("accepted"),
        }),
        el("button", {
          class: "ctl",
          text: "Verwerfen",
          onclick: () => mark("rejected"),
        }),
        el("button", {
          class: "ctl",
          text: "Beobachten",
          onclick: () => mark("watching"),
        }),
        statusChip,
        commentBox,
        el("button", {
          class: "ctl",
          text: "Notiz sichern",
          onclick: () =>
            decisions.set(c.id, f.id, {
              status: stored.status || "watching",
              comment: commentBox.value,
            }),
        }),
      ]),
    );
    card.appendChild(box);
  });
  host.appendChild(card);
}

/**
 * First sentence of a finding, for the heading.
 * The period has to be followed by whitespace or the end of the string, or
 * "0.15 s" ends the sentence after the zero.
 */
function firstSentence(text) {
  const m = /^(.*?[.!?])(\s|$)/.exec(text);
  const s = m ? m[1] : text;
  return s.length > 130 ? s.slice(0, 127).replace(/\s+\S*$/, "") + "…" : s;
}

function statusLabel(s) {
  return s === "accepted"
    ? "übernommen"
    : s === "rejected"
      ? "verworfen"
      : s === "watching"
        ? "beobachten"
        : "offen";
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function renderHistory() {
  const c = current();
  const host = $("history");
  clear(host);
  const card = el("div", { class: "card" });
  const comparisons = c.report.selfComparisons || [];

  if (!comparisons.length) {
    card.appendChild(
      el("p", {
        class: "empty",
        text:
          "Für diesen Spieler liegen keine früheren Messungen vor. Der Eigenvergleich ist die " +
          "aussagekräftigste Auswertung dieses Systems — er braucht mindestens zwei Sitzungen.",
      }),
    );
    host.appendChild(card);
    return;
  }

  card.appendChild(
    el("p", {
      class: "sub",
      style: "margin:0 0 12px",
      text:
        "Veränderung gegenüber den eigenen früheren Sitzungen. Eine Veränderung gilt erst als " +
        "belastbar, wenn sie sowohl das Messrauschen als auch eine trainingsrelevante Mindestgröße übersteigt.",
    }),
  );

  const table = el("table");
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Kenngröße" }),
        el("th", { text: "Früher" }),
        el("th", { text: "Heute" }),
        el("th", { text: "Veränderung" }),
        el("th", { text: "Belastbar?" }),
      ]),
    ]),
  );
  const body = el("tbody");
  for (const s of comparisons) {
    const metric = c.report.metrics.find((m) => m.id === s.featureId);
    body.appendChild(
      el("tr", {}, [
        el("td", { text: (metric && metric.label) || s.featureId }),
        el("td", {
          class: "val",
          text:
            num(s.historyMean, 2) +
            " ± " +
            num(s.historySd, 2) +
            " (n=" +
            s.sampleCount +
            ")",
        }),
        el("td", { class: "val", text: num(s.currentValue, 2) }),
        el("td", {
          class: "val",
          text: (s.delta > 0 ? "+" : "") + num(s.delta, 2),
        }),
        el("td", {}, [
          el("span", {
            class: "chip " + (s.meaningful ? "ok" : ""),
            text: s.meaningful
              ? "ja · " + pct(s.probabilityOfRealChange) + " %"
              : "nein · " + pct(s.probabilityOfRealChange) + " %",
          }),
        ]),
      ]),
    );
  }
  table.appendChild(body);
  card.appendChild(table);
  host.appendChild(card);
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

/**
 * Two clips synchronised by *phase*, not by time.
 *
 * Aligning two serves on the clock compares the loading phase of one with the
 * acceleration of the other and makes every difference look enormous. Aligning
 * them on the phase boundaries the segmentation already found is the only
 * comparison that means anything — and where a phase is missing from one of the
 * clips, the comparison is simply not offered.
 */
function frameForPhase(caseData, phaseId, fraction) {
  const p = (caseData.report.phases || []).find((x) => x.id === phaseId);
  if (!p) return null;
  return p.startFrame + (p.endFrame - p.startFrame) * fraction;
}

function renderCompare() {
  const host = $("compare");
  clear(host);
  const card = el("div", { class: "card" });

  const a = DATA.cases[state.compareA];
  const b = DATA.cases[state.compareB];
  const phasesA = new Set((a.report.phases || []).map((p) => p.id));
  const shared = (b.report.phases || []).filter((p) => phasesA.has(p.id));

  const pick = (which, value) =>
    el(
      "select",
      {
        style:
          "background:var(--raise);color:var(--text);border:1px solid var(--border);" +
          "border-radius:6px;padding:5px 8px;font-size:12px",
        onchange: (e) => {
          state[which] = Number(e.target.value);
          renderCompare();
        },
      },
      DATA.cases.map((c, i) => {
        const o = el("option", { value: i, text: c.title });
        if (i === value) o.setAttribute("selected", "selected");
        return o;
      }),
    );

  card.appendChild(
    el("div", { class: "controls" }, [
      pick("compareA", state.compareA),
      el("span", { class: "sub", text: "gegen" }),
      pick("compareB", state.compareB),
      el("span", { class: "sub", text: "synchronisiert nach Phase:" }),
      el(
        "select",
        {
          style:
            "background:var(--raise);color:var(--text);border:1px solid var(--border);" +
            "border-radius:6px;padding:5px 8px;font-size:12px",
          onchange: (e) => {
            state.comparePhase = e.target.value;
            renderCompare();
          },
        },
        shared.map((p) => {
          const o = el("option", { value: p.id, text: p.label });
          if (p.id === state.comparePhase)
            o.setAttribute("selected", "selected");
          return o;
        }),
      ),
    ]),
  );

  if (!shared.length) {
    card.appendChild(
      el("p", {
        class: "empty",
        style: "margin-top:12px",
        text: "Die beiden Aufnahmen haben keine gemeinsam erkannte Phase. Ein Vergleich wird nicht angeboten.",
      }),
    );
    host.appendChild(card);
    return;
  }
  if (!shared.some((p) => p.id === state.comparePhase))
    state.comparePhase = shared[0].id;

  const split = el("div", { class: "split", style: "margin-top:12px" });
  for (const c of [a, b]) {
    const frame = frameForPhase(c, state.comparePhase, 0.5);
    const col = el("div", {});
    col.appendChild(
      el("div", { style: "font-size:13px;margin-bottom:6px" }, [
        c.title,
        el("span", {
          class: "sub",
          text:
            frame === null
              ? " · Phase fehlt"
              : " · Bild " +
                Math.round(frame) +
                " (" +
                (frame / c.report.video.fps).toFixed(2) +
                " s)",
        }),
      ]),
    );
    if (frame === null) {
      col.appendChild(
        el("p", {
          class: "empty",
          text: "Diese Phase wurde hier nicht erkannt.",
        }),
      );
    } else {
      renderStage(col, c, frame, { showDetected: false });
    }
    split.appendChild(col);
  }
  card.appendChild(split);

  // Side-by-side numbers for the metrics both clips actually measured.
  const table = el("table", { style: "margin-top:16px" });
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Kenngröße" }),
        el("th", { text: a.title }),
        el("th", { text: b.title }),
        el("th", { text: "Differenz" }),
      ]),
    ]),
  );
  const body = el("tbody");
  for (const ma of a.report.metrics) {
    const mb = b.report.metrics.find((m) => m.id === ma.id);
    if (
      !mb ||
      ma.value === null ||
      mb.value === null ||
      ma.rejected ||
      mb.rejected
    )
      continue;
    // A difference is only shown when both measurements would survive on their
    // own; comparing two numbers the system does not trust produces a third
    // number nobody should trust.
    const trustworthy = ma.confidence >= 0.35 && mb.confidence >= 0.35;
    body.appendChild(
      el("tr", {}, [
        el("td", { text: ma.label }),
        el("td", { class: "val", text: ma.formatted }),
        el("td", { class: "val", text: mb.formatted }),
        el(
          "td",
          {},
          trustworthy
            ? [
                el("span", {
                  class: "val",
                  text:
                    (mb.value - ma.value > 0 ? "+" : "") +
                    num(mb.value - ma.value, 2) +
                    " " +
                    ma.unit,
                }),
              ]
            : [el("span", { class: "chip warn", text: "zu unsicher" })],
        ),
      ]),
    );
  }
  table.appendChild(body);
  card.appendChild(table);
  host.appendChild(card);
}

/* ------------------------------------------------------------------ */
/* Pipeline trail                                                      */
/* ------------------------------------------------------------------ */

function renderPipeline() {
  const c = current();
  const host = $("pipeline");
  clear(host);
  const card = el("div", { class: "card" });
  card.appendChild(
    el("p", {
      class: "sub",
      style: "margin:0 0 12px",
      text:
        "Wenn ein Ergebnis falsch aussieht, ist die erste Frage nicht, wie man es besser formuliert, " +
        "sondern welcher Schritt der Kette nicht getragen hat.",
    }),
  );

  for (const layer of c.report.pipeline) {
    const diagnostics = Object.entries(layer.diagnostics || {}).filter(
      ([, v]) => v !== null && v !== undefined,
    );
    card.appendChild(
      el("div", { class: "pipeline-row" }, [
        el("div", { class: "id", text: layer.id }),
        el("div", {}, [
          layer.name,
          layer.notes.length
            ? el("div", { class: "note", text: layer.notes.join(" ") })
            : null,
        ]),
        el("span", {
          class: "chip " + statusClass(layer.status),
          text: layer.status + " · " + Math.round(layer.quality * 100) + " %",
        }),
      ]),
    );
    if (diagnostics.length) {
      card.appendChild(
        el(
          "div",
          { class: "diagnostics" },
          diagnostics.map(([k, v]) => el("span", { text: k + " = " + v })),
        ),
      );
    }
  }
  host.appendChild(card);
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  const c = current();
  $("eyebrow").textContent =
    c.report.player.displayName +
    " · " +
    strokeLabel(c.report.stroke) +
    " · " +
    c.report.video.captureFps +
    " fps";
  $("title").textContent = c.title;
  $("subtitle").textContent = c.subtitle;
  renderCases();
  renderVerdict();
  renderQuality();
  renderPlayer();
  render3D();
  renderMetrics();
  renderFindings();
  renderHistory();
  renderCompare();
  renderPipeline();
}

function strokeLabel(s) {
  return s === "serve"
    ? "Aufschlag"
    : s === "forehand"
      ? "Vorhand"
      : "Rückhand";
}

document.addEventListener("keydown", (e) => {
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
  if (e.key === " ") {
    e.preventDefault();
    state.playing = !state.playing;
    renderPlayer();
    if (state.playing) tick();
  }
  if (e.key === "ArrowLeft") {
    state.playing = false;
    state.frame = Math.max(0, state.frame - 1);
    renderPlayer();
    render3D();
  }
  if (e.key === "ArrowRight") {
    state.playing = false;
    state.frame = Math.min(current().overlay.length - 1, state.frame + 1);
    renderPlayer();
    render3D();
  }
});

render();
