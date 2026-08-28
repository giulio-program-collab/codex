/* eslint-env browser */
/**
 * The advertisement, as a function of time.
 *
 * Nothing animates by itself: `window.setT(seconds)` positions every element
 * for that instant and returns. A recorder steps through the timeline frame by
 * frame and gets the same picture every run, which is what makes the output a
 * film rather than a screen capture of a browser doing its best.
 *
 * The shape of it: a serve on a court, filmed. The frame pulls back and turns
 * out to have been a phone all along. Then it dives through the phone's screen
 * into the app, and the app explains itself in three steps before admitting
 * what it cannot do.
 */
(function () {
  "use strict";

  const S = window.SKELETON;
  const cv = document.getElementById("film");
  const ctx = cv.getContext("2d");
  const W = 1920;
  const H = 1080;

  /* ---------------- easing ---------------- */

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ramp = (t, a, b) => {
    const x = clamp((t - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  };
  const band = (t, a, b, inS = 0.45, outS = 0.45) => ramp(t, a, a + inS) * (1 - ramp(t, b - outS, b));
  const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const mix = (a, b, k) => a + (b - a) * k;

  const set = (id, opacity, y, scale) => {
    const el = document.getElementById(id);
    el.style.opacity = String(opacity);
    el.style.transform = `translateY(${y || 0}px)` + (scale ? ` scale(${scale})` : "");
  };

  /* ---------------- images ---------------- */

  const IMG = {};
  // The rectangles the film points at, in each screenshot's own pixels.
  const REGION = window.__ADREGION || {};
  const imgLoads = Object.entries(window.__ADIMG || {}).map(([key, src]) => new Promise((res) => {
    const im = new Image();
    im.onload = () => { IMG[key] = im; res(); };
    im.onerror = () => res();
    im.src = src;
  }));

  /* ---------------- primitives ---------------- */

  /** Appends a rounded rectangle to the current path — it does not begin one, so
   *  two calls in a row make a ring that `fill("evenodd")` can hollow out. */
  function rrPath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    rrPath(c, x, y, w, h, r);
  }

  /* ---------------- the footage ---------------- */

  const FULL = { x: 0, y: 0, w: W, h: H };
  // A phone held sideways — which is also how the app asks you to film.
  const PHONE = { x: 1290 - 900 / 2, y: 552 - 506 / 2, w: 900, h: 506 };

  const lerpRect = (a, b, k) => ({
    x: mix(a.x, b.x, k), y: mix(a.y, b.y, k),
    w: mix(a.w, b.w, k), h: mix(a.h, b.h, k),
  });
  const grow = (r, k) => ({
    x: r.x + (r.w - r.w * k) / 2, y: r.y + (r.h - r.h * k) / 2,
    w: r.w * k, h: r.h * k,
  });

  /**
   * Where the footage sits at time t, and how solid it is.
   * One rectangle carries the whole first act: the camera pushes in on the
   * court, the rectangle shrinks into a phone, then it flies past the frame
   * and we are inside the app.
   */
  function footage(t) {
    const pushed = grow(FULL, 1 + 0.13 * easeOut(ramp(t, 0.3, 6.9)));
    if (t < 6.9) return { rect: pushed, alpha: ramp(t, 0.2, 1.4), bezel: 0 };
    if (t < 10.3) {
      const k = easeInOut(clamp((t - 6.9) / 2.5, 0, 1));
      return { rect: lerpRect(pushed, PHONE, k), alpha: 1, bezel: ramp(t, 7.6, 9.0) };
    }
    const k = easeInOut(clamp((t - 10.3) / 1.5, 0, 1));
    return {
      rect: lerpRect(PHONE, grow(FULL, 3.4), k),
      alpha: 1 - ramp(t, 11.0, 11.8),
      bezel: 1 - ramp(t, 10.3, 10.9),
    };
  }

  /**
   * The place the serve happens in: a fence, a horizon, and a court surface.
   * A single gradient over the whole frame reads as a void; the break at the
   * horizon and the mesh above it are what make it somewhere.
   */
  function drawGround(rect, hz) {
    const back = ctx.createLinearGradient(0, rect.y, 0, hz);
    back.addColorStop(0, "#0a1216");
    back.addColorStop(1, "#132a32");
    ctx.fillStyle = back;
    ctx.fillRect(rect.x, rect.y, rect.w, hz - rect.y);
    const floor = ctx.createLinearGradient(0, hz, 0, rect.y + rect.h);
    floor.addColorStop(0, "#20505e");
    floor.addColorStop(0.45, "#1a4250");
    floor.addColorStop(1, "#0d2028");
    ctx.fillStyle = floor;
    ctx.fillRect(rect.x, hz, rect.w, rect.y + rect.h - hz);
    // Fence mesh, faint, only where the light catches it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, hz - rect.y);
    ctx.clip();
    ctx.strokeStyle = "rgba(150,178,188,0.055)";
    ctx.lineWidth = 1;
    const step = Math.max(14, rect.h * 0.030);
    for (let x = rect.x; x < rect.x + rect.w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, rect.y);
      ctx.lineTo(x + 0.5, hz);
      ctx.stroke();
    }
    for (let y = hz; y > rect.y; y -= step) {
      ctx.beginPath();
      ctx.moveTo(rect.x, y + 0.5);
      ctx.lineTo(rect.x + rect.w, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = "rgba(170,196,204,0.30)";
    ctx.fillRect(rect.x, hz - 2, rect.w, 2);
  }

  /** The serve, played inside a rectangle, with the court under it. */
  function drawFootage(rect, frameIndex, alpha, markers) {
    if (alpha <= 0.003) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, Math.max(2, 14 * (rect.w / W)));
    ctx.clip();
    // The court surface: a hard blue-green that darkens away from the camera.
    // Back fence above, court surface below: without the break at the horizon
    // a single gradient reads as a void rather than a place.
    const hz = rect.y + rect.h * 0.27;
    drawGround(rect, hz);
    const k = rect.h / H;
    const view = window.FIGURE.makeView(880 * k, rect.x + rect.w * 0.685, rect.y + rect.h * 0.50);
    window.FIGURE.drawFigure(ctx, frameIndex, view, {
      alpha: 1, court: true, shadow: true, markers: markers || 0,
    });
    ctx.restore();
  }

  /** A phone body around the screen, plus the marks of something recording. */
  function drawPhone(rect, alpha) {
    if (alpha <= 0.003) return;
    const pad = rect.h * 0.052;
    const bx = rect.x - pad;
    const by = rect.y - pad;
    const bw = rect.w + pad * 2;
    const bh = rect.h + pad * 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    // Body, drawn as a ring so it never paints over the picture.
    ctx.beginPath();
    rrPath(ctx, bx - 3, by - 3, bw + 6, bh + 6, pad * 2.6);
    rrPath(ctx, rect.x, rect.y, rect.w, rect.h, pad * 0.9);
    ctx.fillStyle = "#1a2226";
    ctx.fill("evenodd");
    roundRect(ctx, bx - 3, by - 3, bw + 6, bh + 6, pad * 2.6);
    ctx.strokeStyle = "rgba(150,175,185,0.42)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Lens on the short edge, and the seam of the frame.
    ctx.beginPath();
    ctx.arc(bx + pad * 0.52, by + bh / 2, pad * 0.20, 0, Math.PI * 2);
    ctx.fillStyle = "#0a1013";
    ctx.fill();
    // Recording marks, inside the picture.
    ctx.globalAlpha = alpha * 0.92;
    ctx.fillStyle = "#e2766a";
    ctx.beginPath();
    ctx.arc(rect.x + 34, rect.y + 34, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "500 20px PlexMono, monospace";
    ctx.fillStyle = "rgba(238,243,244,0.88)";
    ctx.textBaseline = "middle";
    ctx.fillText("REC  00:00:41", rect.x + 54, rect.y + 35);
    ctx.textAlign = "right";
    ctx.fillText("60 fps", rect.x + rect.w - 30, rect.y + 35);
    ctx.textAlign = "left";
    ctx.restore();
  }

  /* ---------------- the app window ---------------- */

  const WIN = { x: 560, y: 168, w: 1300, h: 744 };
  const BAR = 56;

  /**
   * Draws the app in a window, with `content(rect)` painting whatever is on
   * screen at that moment. `k` scales the whole window about its centre, which
   * is how it arrives out of the dive.
   */
  function drawWindow(alpha, k, content) {
    if (alpha <= 0.003) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const cx = WIN.x + WIN.w / 2;
    const cy = WIN.y + WIN.h / 2;
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.translate(-cx, -cy);

    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 60;
    ctx.shadowOffsetY = 24;
    roundRect(ctx, WIN.x, WIN.y, WIN.w, WIN.h, 16);
    ctx.fillStyle = "#0d1215";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Title bar.
    ctx.save();
    roundRect(ctx, WIN.x, WIN.y, WIN.w, WIN.h, 16);
    ctx.clip();
    ctx.fillStyle = "#161d21";
    ctx.fillRect(WIN.x, WIN.y, WIN.w, BAR);
    ctx.fillStyle = "#232d32";
    ctx.fillRect(WIN.x, WIN.y + BAR - 1, WIN.w, 1);
    const dots = ["#3a464c", "#3a464c", "#3a464c"];
    dots.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(WIN.x + 30 + i * 24, WIN.y + BAR / 2, 7, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
    });
    ctx.font = "500 20px PlexMono, monospace";
    ctx.fillStyle = "#6d7f86";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Baseline Vision — Analyse", WIN.x + WIN.w / 2, WIN.y + BAR / 2 + 1);
    ctx.textAlign = "left";
    ctx.restore();

    const content_ = { x: WIN.x, y: WIN.y + BAR, w: WIN.w, h: WIN.h - BAR };
    ctx.save();
    roundRect(ctx, WIN.x, WIN.y, WIN.w, WIN.h, 16);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(content_.x, content_.y, content_.w, content_.h);
    ctx.clip();
    content(content_);
    ctx.restore();

    roundRect(ctx, WIN.x, WIN.y, WIN.w, WIN.h, 16);
    ctx.strokeStyle = "rgba(120,145,155,0.30)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A screenshot of the running app, framed inside the window.
   *
   * The picture always spans the window's full width and scrolls vertically:
   * these panels are wide rows whose meaning sits at both ends — the name of
   * the measurement on the left, its value on the right — so cropping sideways
   * to magnify a row throws away the half that makes it a measurement.
   * `scroll` is how far down the page has been carried, in source pixels.
   * Returns the mapping, so a caller can point at a row it knows the y of.
   */
  function drawShot(img, box, scroll) {
    ctx.fillStyle = "#0f1418";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    if (!img) return { k: 1, y0: box.y };
    const k = box.w / img.width;
    const dh = img.height * k;
    const y0 = dh <= box.h
      ? box.y + (box.h - dh) / 2
      : box.y - clamp(scroll * k, 0, dh - box.h);
    ctx.drawImage(img, box.x, y0, box.w, dh);
    return { k, y0 };
  }

  /**
   * A frame around one region of the app, given in the screenshot's own pixels,
   * with the rest of the page pushed back — so the words on the left and the
   * part of the screen they are about are unmistakably the same thing.
   */
  function pointAt(box, map, src, alpha) {
    if (alpha <= 0.01 || !src) return;
    const x = box.x + src[0] * map.k;
    const y = map.y0 + src[1] * map.k;
    const w = (src[2] - src[0]) * map.k;
    const h = (src[3] - src[1]) * map.k;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(8,14,17,0.62)";
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    rrPath(ctx, x, y, w, h, 8);
    ctx.fill("evenodd");
    roundRect(ctx, x, y, w, h, 8);
    ctx.strokeStyle = "rgba(77,189,180,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------- the timeline ---------------- */

  const T = {
    court: [0.0, 7.2],
    phone: [7.0, 10.4],
    app1: [11.6, 16.3],
    app2: [16.1, 21.1],
    app3: [20.9, 25.5],
    refuse: [25.3, 29.5],
    lockup: [29.3, 34.6],
  };
  const DURATION = 34.6;

  function setT(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0a0f11";
    ctx.fillRect(0, 0, W, H);

    /* --- act one: the serve, the phone, the dive ------------------- */
    if (t < 12.2) {
      // Played at roughly a third of real speed, then again inside the phone.
      const n = S.frames.length - 1;
      let frame;
      if (t < 7.0) frame = clamp((t - 0.5) * S.fps * 0.30, 0, n);
      else frame = clamp((t - 7.2) * S.fps * 0.44, 0, n);
      const f = footage(t);
      drawFootage(f.rect, frame, f.alpha, 0);
      drawPhone(f.rect, f.bezel);
    }

    set("s-court", band(t, T.court[0], T.court[1], 1.0, 0.7),
        26 * (1 - easeOut(ramp(t, 0.8, 2.2))));
    document.getElementById("court-rule").style.width = `${190 * easeOut(ramp(t, 1.3, 2.6))}px`;

    const phoneA = band(t, T.phone[0], T.phone[1], 0.7, 0.5);
    set("s-phone", phoneA, 24 * (1 - easeOut(ramp(t, 7.4, 8.6))));
    document.getElementById("phone-foot").style.opacity = String(ramp(t, 8.8, 9.6));

    /* --- act two: inside the app ----------------------------------- */
    // The window arrives out of the dive, oversized, and settles.
    const winA = ramp(t, 11.0, 11.9) * (1 - ramp(t, 25.0, 25.6));
    if (winA > 0.003) {
      const settle = mix(1.32, 1.0, easeOut(ramp(t, 11.0, 12.3)));
      drawWindow(winA, settle, (box) => {
        if (t < 16.2) {
          // Step one: the app watching the body it was handed.
          ctx.fillStyle = "#0c1114";
          ctx.fillRect(box.x, box.y, box.w, box.h);
          drawGround(box, box.y + box.h * 0.26);
          const frame = clamp((t - 11.9) * S.fps * 0.30, 0, S.frames.length - 1);
          const view = window.FIGURE.makeView(box.h * 0.94, box.x + box.w * 0.53, box.y + box.h * 0.47);
          window.FIGURE.drawFigure(ctx, frame, view, {
            alpha: 1, court: true, shadow: true, markers: ramp(t, 12.5, 13.8),
          });
          // The count of tracked points, ticking up as the overlay lands.
          ctx.font = "500 22px PlexMono, monospace";
          ctx.fillStyle = `rgba(77,189,180,${ramp(t, 13.0, 13.9)})`;
          ctx.textBaseline = "top";
          const found = Math.round(22 * ramp(t, 12.7, 14.2));
          ctx.fillText(`${found} / 22 Punkte verfolgt`, box.x + 26, box.y + 22);
          ctx.fillStyle = `rgba(154,171,178,${ramp(t, 13.4, 14.3)})`;
          ctx.textAlign = "right";
          ctx.fillText("Bild 214 · 1,78 s", box.x + box.w - 26, box.y + 22);
          ctx.textAlign = "left";
        } else if (t < 21.0) {
          // Step two: the page scrolls to the knee row, then singles it out.
          const k = easeInOut(clamp((t - 16.8) / 2.6, 0, 1));
          const map = drawShot(IMG.metrics, box, mix(0, 250, k));
          pointAt(box, map, REGION.metrics, ramp(t, 18.4, 19.4));
        } else {
          // Step three: the app's report on itself, top of the page.
          const k = easeInOut(clamp((t - 21.4) / 3.2, 0, 1));
          const map = drawShot(IMG.verdict, box, 0);
          pointAt(box, map, REGION.verdict, ramp(t, 22.4, 23.4) * k);
        }
      });
    }

    const step = (id, a, b) => {
      const A = band(t, a, b, 0.55, 0.45);
      set(id, A, 22 * (1 - easeOut(ramp(t, a + 0.1, a + 1.2))));
    };
    step("s-app1", T.app1[0], T.app1[1]);
    step("s-app2", T.app2[0], T.app2[1]);
    step("s-app3", T.app3[0], T.app3[1]);
    document.getElementById("app1-pill").style.opacity = String(ramp(t, 14.2, 15.0));
    document.getElementById("app2-pill").style.opacity = String(ramp(t, 18.7, 19.5));
    document.getElementById("app3-pill").style.opacity = String(ramp(t, 23.2, 24.0));

    /* --- act three: the refusal, and the name ---------------------- */
    const refA = band(t, T.refuse[0], T.refuse[1], 0.6, 0.5);
    set("s-refuse", refA, 24 * (1 - easeOut(ramp(t, 25.5, 26.5))));
    Array.from(document.querySelectorAll("#s-refuse li")).forEach((li, i) => {
      li.style.opacity = String(ramp(t, 26.3 + i * 0.42, 27.0 + i * 0.42));
    });

    const lockA = band(t, T.lockup[0], T.lockup[1], 0.8, 0.0);
    set("s-lockup", lockA, 18 * (1 - easeOut(ramp(t, 29.5, 30.7))));
    document.getElementById("lockup-claim").style.opacity = String(ramp(t, 30.0, 30.9));
    document.getElementById("lockup-rule").style.width = `${380 * easeOut(ramp(t, 30.8, 31.8))}px`;
    document.getElementById("lockup-under").style.opacity = String(ramp(t, 31.2, 32.0));
    document.getElementById("lockup-foot").style.opacity = String(ramp(t, 32.4, 33.2));

    // A last, quiet pass of the serve behind the name.
    if (t > 29.6) {
      const late = clamp((t - 29.6) * S.fps * 0.20, 0, S.frames.length - 1);
      const view = window.FIGURE.makeView(660, 1680, 660);
      window.FIGURE.drawFigure(ctx, late, view, {
        alpha: 0.13 * ramp(t, 29.8, 31.0), court: false, shadow: false, markers: 0,
      });
    }
  }

  window.setT = setT;
  window.AD_DURATION = DURATION;
  window.adReady = Promise.all([document.fonts.ready].concat(imgLoads)).then(() => {
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
