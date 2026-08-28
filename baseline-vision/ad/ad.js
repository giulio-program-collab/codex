/* eslint-env browser */
/**
 * The advertisement, as a function of time.
 *
 * Nothing here animates by itself: `window.setT(seconds)` positions every
 * element for that instant and returns. A recorder can then step through the
 * timeline frame by frame and get the same picture every run, which is what
 * makes the output a film rather than a screen capture of a browser doing its
 * best.
 */
(function () {
  "use strict";

  const S = window.SKELETON;
  const stage = document.getElementById("skeleton");
  const ctx = stage.getContext("2d");
  const gridCtx = document.getElementById("grid").getContext("2d");
  const W = 1920;
  const H = 1080;

  /* ---------------- easing and helpers ---------------- */

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /** Smooth 0→1 across [a, b]. */
  const ramp = (t, a, b) => {
    const x = clamp((t - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  };
  /** 1 inside [a, b], fading in over `inS` and out over `outS`. */
  const band = (t, a, b, inS = 0.45, outS = 0.45) => ramp(t, a, a + inS) * (1 - ramp(t, b - outS, b));
  const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);

  const set = (id, opacity, y, extra) => {
    const el = document.getElementById(id);
    el.style.opacity = String(opacity);
    el.style.transform = `translateY(${y || 0}px)` + (extra || "");
  };

  /* ---------------- the serve ---------------- */

  const box = S.box;
  const FIG_H = 840; // pixels of stage height the figure occupies
  const scale = FIG_H / box.h;

  /**
   * Draws the fixture serve at a given moment.
   * `x` is where the figure's centre sits, `alpha` its opacity, and `trail`
   * how many earlier frames ghost behind it.
   */
  function drawServe(frameIndex, x, y, alpha, trail) {
    const draw = (idx, a, lineWidth) => {
      const f = S.frames[clamp(Math.round(idx), 0, S.frames.length - 1)];
      const map = (p) => [x + (p[0] - box.x - box.w / 2) * scale, y + (p[1] - box.y - box.h / 2) * scale];
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgba(77, 189, 180, ${a})`;
      ctx.lineWidth = lineWidth;
      for (const [i, j] of S.bones) {
        const p = map(f.p[i]);
        const q = map(f.p[j]);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
      }
      // Racket and ball in the ball's own colour.
      const g = map([f.r[0], f.r[1]]);
      const hd = map([f.r[2], f.r[3]]);
      ctx.strokeStyle = `rgba(195, 214, 53, ${a})`;
      ctx.lineWidth = lineWidth * 0.85;
      ctx.beginPath();
      ctx.moveTo(g[0], g[1]);
      ctx.lineTo(hd[0], hd[1]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hd[0], hd[1], lineWidth * 2.6, 0, Math.PI * 2);
      ctx.stroke();
      if (f.b) {
        const b = map(f.b);
        ctx.fillStyle = `rgba(195, 214, 53, ${a})`;
        ctx.beginPath();
        ctx.arc(b[0], b[1], lineWidth * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Joints as small nodes: this is a measuring instrument, not a cartoon.
      ctx.fillStyle = `rgba(238, 243, 244, ${a * 0.9})`;
      for (const p of f.p) {
        const q = map(p);
        ctx.beginPath();
        ctx.arc(q[0], q[1], lineWidth * 0.62, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    for (let k = trail; k >= 1; k--) {
      draw(frameIndex - k * 6, alpha * 0.06 * (1 - k / (trail + 1)), 3);
    }
    draw(frameIndex, alpha, 5);
  }

  /* ---------------- the grid ---------------- */

  function drawGrid(alpha) {
    gridCtx.clearRect(0, 0, W, H);
    if (alpha <= 0.001) return;
    gridCtx.strokeStyle = `rgba(46, 60, 66, ${alpha})`;
    gridCtx.lineWidth = 1;
    for (let x = 0; x <= W; x += 60) {
      gridCtx.beginPath();
      gridCtx.moveTo(x + 0.5, 0);
      gridCtx.lineTo(x + 0.5, H);
      gridCtx.stroke();
    }
    for (let y = 0; y <= H; y += 60) {
      gridCtx.beginPath();
      gridCtx.moveTo(0, y + 0.5);
      gridCtx.lineTo(W, y + 0.5);
      gridCtx.stroke();
    }
  }

  /* ---------------- the fourteen layers ---------------- */

  const LAYERS = ["Video", "Kamera", "Erkennung", "Pose", "Tracking", "3D", "Schläger", "Ball",
                  "Phasen", "Merkmale", "Referenz", "Confidence", "Plausibilität", "Bericht"];
  const rail = document.getElementById("chain-rail");
  const names = document.getElementById("chain-names");
  LAYERS.forEach((name) => {
    rail.appendChild(document.createElement("i"));
    const span = document.createElement("span");
    span.textContent = name;
    names.appendChild(span);
  });

  /* ---------------- the timeline ---------------- */

  const SCENES = {
    intro: [0.0, 6.4],
    verdict: [6.0, 11.4],
    mechanism: [11.2, 16.4],
    chain: [16.2, 20.6],
    result: [20.4, 25.4],
    refusal: [25.2, 30.2],
    lockup: [30.0, 35.0],
  };
  const DURATION = 35.0;

  function setT(t) {
    ctx.clearRect(0, 0, W, H);

    /* Scene 1 — the serve, playing slowly, then held. */
    const introA = band(t, SCENES.intro[0], SCENES.intro[1], 0.8, 0.9);
    // Grid appears with the figure and stays under the analytical scenes.
    drawGrid(0.9 * ramp(t, 0.6, 2.0) * (1 - ramp(t, 30.4, 31.6)));

    if (t < 11.6) {
      // The stroke runs at a third of real speed, then freezes at contact.
      const contactFrame = S.contactT * S.fps;
      const played = clamp((t - 0.4) * S.fps * 0.34, 0, contactFrame + 26);
      const held = t > 6.2 ? contactFrame + 26 : played;
      // The figure enters on the right, where the headline is not, and walks
      // into the left half as the old verdict takes the stage.
      const x = 1370 - 1000 * easeOut(ramp(t, 5.6, 7.6));
      drawServe(held, x, 520, Math.max(introA, 0.85 * ramp(t, 0.4, 1.6) * (1 - ramp(t, 11.0, 11.6))), 6);
    }

    /* Scene 1 text */
    set("intro", introA, 26 * (1 - easeOut(ramp(t, 0.9, 2.2))));
    document.getElementById("intro-rule").style.width = `${180 * easeOut(ramp(t, 1.4, 2.6))}px`;

    /* Scene 2 — the old verdict lands. */
    const vA = band(t, SCENES.verdict[0], SCENES.verdict[1], 0.5, 0.5);
    set("verdict", vA, 40 * (1 - easeOut(ramp(t, 6.2, 7.2))));
    const punch = 1 + 0.16 * (1 - easeOut(ramp(t, 6.3, 7.0)));
    document.getElementById("verdict-score").style.transform = `scale(${punch})`;
    document.getElementById("verdict-score").style.transformOrigin = "left center";

    /* Scene 3 — the mechanism. */
    const mA = band(t, SCENES.mechanism[0], SCENES.mechanism[1], 0.5, 0.5);
    set("mechanism", mA, 0);
    document.getElementById("mech-left").style.opacity = String(ramp(t, 11.5, 12.3));
    document.getElementById("mech-right").style.opacity = String(ramp(t, 12.9, 13.7));
    document.getElementById("mech-caption").style.opacity = String(ramp(t, 14.4, 15.2));

    /* Scene 4 — the chain lights up. */
    const cA = band(t, SCENES.chain[0], SCENES.chain[1], 0.5, 0.5);
    set("chain", cA, 0);
    const lit = clamp((t - 16.9) / 2.1, 0, 1) * LAYERS.length;
    Array.from(rail.children).forEach((el, i) => {
      const on = clamp(lit - i, 0, 1);
      el.style.background = on > 0 ? `rgba(77, 189, 180, ${0.25 + 0.75 * on})` : "";
      el.style.height = `${10 + 10 * on}px`;
    });
    Array.from(names.children).forEach((el, i) => {
      el.style.color = lit > i + 0.5 ? "#93a3aa" : "";
    });

    /* Scene 5 — the measurement, with its interval and the truth inside it. */
    const rA = band(t, SCENES.result[0], SCENES.result[1], 0.5, 0.5);
    set("result", rA, 24 * (1 - easeOut(ramp(t, 20.6, 21.6))));
    // Axis spans 0…100 degrees over the bar's width.
    const grow = easeOut(ramp(t, 21.4, 22.8));
    const pos = (deg) => `${deg}%`;
    document.getElementById("bar-interval").style.left = pos(51);
    document.getElementById("bar-interval").style.width = `${28.2 * grow}%`;
    document.getElementById("bar-point").style.left = pos(65.1);
    document.getElementById("bar-point").style.opacity = String(ramp(t, 21.6, 22.4));
    document.getElementById("bar-truth").style.left = pos(66);
    document.getElementById("bar-truth").style.opacity = String(ramp(t, 23.0, 23.8));
    document.getElementById("bar-truthlabel").style.left = pos(66);
    document.getElementById("bar-truthlabel").style.opacity = String(ramp(t, 23.2, 24.0));

    /* Scene 6 — the refusal. */
    const fA = band(t, SCENES.refusal[0], SCENES.refusal[1], 0.5, 0.5);
    set("refusal", fA, 24 * (1 - easeOut(ramp(t, 25.4, 26.4))));
    Array.from(document.querySelectorAll("#refusal li")).forEach((li, i) => {
      li.style.opacity = String(ramp(t, 26.2 + i * 0.45, 26.9 + i * 0.45));
    });

    /* Scene 7 — the lockup. */
    const lA = band(t, SCENES.lockup[0], SCENES.lockup[1], 0.7, 0.0);
    set("lockup", lA, 20 * (1 - easeOut(ramp(t, 30.2, 31.4))));
    document.getElementById("lockup-rule").style.width = `${420 * easeOut(ramp(t, 31.0, 32.2))}px`;
    document.getElementById("lockup-claim").style.opacity = String(ramp(t, 31.4, 32.4));
    document.getElementById("lockup-foot").style.opacity = String(ramp(t, 32.8, 33.6));

    // A last, quiet pass of the stroke behind the lockup.
    if (t > 30.2) {
      const late = clamp((t - 30.2) * S.fps * 0.22, 0, S.frames.length - 1);
      drawServe(late, 1480, 540, 0.16 * ramp(t, 30.4, 31.6), 4);
    }
  }

  window.setT = setT;
  window.AD_DURATION = DURATION;
  window.adReady = document.fonts.ready.then(() => {
    setT(0);
    return true;
  });

  /**
   * Plays by itself unless a recorder is driving the timeline.
   *
   * The film is rendered by stepping `setT` frame by frame, which needs the
   * page to hold still. Everywhere else — someone opening the page — it should
   * simply run, and run again.
   */
  if (!window.__RECORDING) {
    let start = null;
    const tick = (now) => {
      if (start === null) start = now;
      setT(((now - start) / 1000) % DURATION);
      requestAnimationFrame(tick);
    };
    window.adReady.then(() => requestAnimationFrame(tick));
  }
})();
