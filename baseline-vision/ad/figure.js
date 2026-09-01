/* eslint-env browser */
/**
 * Drawing the server.
 *
 * The joints are the ones the tests measure; everything here is only how they
 * are shown. What makes a figure read as a person rather than a diagram is
 * mostly three things: limbs that have thickness in metres instead of a stroke
 * width in pixels, parts that occlude each other in depth order, and clothing —
 * a shirt, shorts and shoes in tones that differ from skin. All three are here.
 */
(function () {
  "use strict";

  const S = window.SKELETON;
  const J = {};
  S.joints.forEach((name, i) => (J[name] = i));

  const SKIN = [226, 190, 156];
  const SHIRT = [244, 248, 249];
  const SHORTS = [126, 149, 160];
  const SHOE = [238, 243, 244];
  const HAIR = [46, 38, 33];
  const GROUND = [12, 20, 24];

  /** Mix towards the ground colour: how a surface turned away from us looks. */
  function tone(rgb, away, alpha) {
    const k = away ? 0.46 : 0;
    const c = rgb.map((v, i) => Math.round(v * (1 - k) + GROUND[i] * k));
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  }

  /**
   * Segments as tapered capsules, with half-widths in metres.
   *
   * These are body radii, not drawing weights: a thigh is about eleven
   * centimetres across at the hip, an ankle about five. Because the exporter
   * hands over pixels per metre for each frame, the figure keeps human
   * proportions at whatever size the film asks for.
   */
  const LEGS = [
    ["hipL", "kneeL", 0.062, 0.046],
    ["kneeL", "ankleL", 0.046, 0.032],
    ["hipR", "kneeR", 0.062, 0.046],
    ["kneeR", "ankleR", 0.046, 0.032],
  ];
  const ARMS = [
    ["shoulderL", "elbowL", 0.048, 0.036],
    ["elbowL", "wristL", 0.036, 0.026],
    ["shoulderR", "elbowR", 0.048, 0.036],
    ["elbowR", "wristR", 0.036, 0.026],
  ];
  const ALL_LIMBS = LEGS.concat(ARMS);

  function capsule(ctx, a, b, wa, wb, fill) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    ctx.beginPath();
    ctx.moveTo(a[0] + nx * wa, a[1] + ny * wa);
    ctx.lineTo(b[0] + nx * wb, b[1] + ny * wb);
    ctx.arc(b[0], b[1], wb, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false);
    ctx.lineTo(a[0] - nx * wa, a[1] - ny * wa);
    ctx.arc(a[0], a[1], wa, Math.atan2(-ny, -nx), Math.atan2(ny, nx), false);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    // A disc at the far end closes the seam where the next capsule starts.
    ctx.beginPath();
    ctx.arc(b[0], b[1], wb, 0, Math.PI * 2);
    ctx.fill();
  }

  const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

  /** A polygon with rounded corners — the trunk, drawn through the real joints. */
  function roundedPoly(ctx, pts, r) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const a = lerp(cur, prev, Math.min(0.5, r / (Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) || 1)));
      const b = lerp(cur, next, Math.min(0.5, r / (Math.hypot(cur[0] - next[0], cur[1] - next[1]) || 1)));
      if (i === 0) ctx.moveTo(a[0], a[1]);
      else ctx.lineTo(a[0], a[1]);
      ctx.quadraticCurveTo(cur[0], cur[1], b[0], b[1]);
    }
    ctx.closePath();
  }

  /**
   * A racket at its real size: a 33 cm head on a 68 cm frame, with a throat
   * that joins the shaft to the hoop. Drawn as a filled hoop rather than an
   * outline, because an outline at this size reads as a butterfly net.
   */
  function racket(ctx, grip, tip, mPx, alpha, away) {
    const dx = tip[0] - grip[0];
    const dy = tip[1] - grip[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const headLen = 0.165 * mPx;   // half of 33 cm
    const headWide = 0.122 * mPx;
    const cx = tip[0] - ux * headLen;
    const cy = tip[1] - uy * headLen;
    const throat = [cx - ux * headLen * 0.95, cy - uy * headLen * 0.95];
    const rim = away ? "rgba(150,168,176," : "rgba(238,243,244,";
    const dark = away ? "rgba(20,32,38," : "rgba(30,46,54,";

    ctx.save();
    ctx.globalAlpha = alpha;
    // Shaft, with a throat that opens into the hoop.
    ctx.strokeStyle = rim + "1)";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(2, 0.020 * mPx);
    ctx.beginPath();
    ctx.moveTo(grip[0], grip[1]);
    ctx.lineTo(throat[0], throat[1]);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, 0.012 * mPx);
    for (const s of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(throat[0], throat[1]);
      ctx.lineTo(cx + px * s * headWide * 0.86 - ux * headLen * 0.5,
                 cy + py * s * headWide * 0.86 - uy * headLen * 0.5);
      ctx.stroke();
    }
    // Hoop: a dark string bed inside a bright rim.
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(uy, ux));
    ctx.beginPath();
    ctx.ellipse(0, 0, headLen, headWide, 0, 0, Math.PI * 2);
    ctx.fillStyle = dark + "0.72)";
    ctx.fill();
    ctx.strokeStyle = rim + "1)";
    ctx.lineWidth = Math.max(2, 0.016 * mPx);
    ctx.stroke();
    ctx.strokeStyle = rim + "0.30)";
    ctx.lineWidth = Math.max(1, 0.0045 * mPx);
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      const x = (i / 3.6) * headLen;
      const h = headWide * Math.sqrt(Math.max(0, 1 - (x / headLen) ** 2)) * 0.94;
      ctx.moveTo(x, -h);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      const y = (i / 2.6) * headWide;
      const w = headLen * Math.sqrt(Math.max(0, 1 - (y / headWide) ** 2)) * 0.94;
      ctx.moveTo(-w, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Draws one frame of the serve.
   * `view` maps a source pixel onto the stage; `opts` carries opacity, whether
   * to draw the court and the shadow, and how strongly to lay the machine's
   * skeleton over the body.
   */
  function drawFigure(ctx, frameIndex, view, opts) {
    const o = opts || {};
    const alpha = o.alpha === undefined ? 1 : o.alpha;
    if (alpha <= 0.002) return;
    const f = S.frames[Math.max(0, Math.min(S.frames.length - 1, Math.round(frameIndex)))];
    const m = view.map;
    const scale = view.scale;
    const mPx = f.mpx * scale; // pixels per metre for this frame
    const P = (name) => m(f.p[J[name]]);

    ctx.save();
    ctx.globalAlpha = alpha;

    if (o.court) {
      ctx.lineWidth = Math.max(1, scale * 2.4);
      ctx.strokeStyle = `rgba(146, 170, 178, ${0.42 * alpha})`;
      for (const [a, b] of S.court) {
        const p = m(a);
        const q = m(b);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
      }
    }

    if (o.shadow) {
      // One soft pool under the feet reads as ground contact; a shadow drawn
      // limb by limb reads as debris scattered across the court.
      const a = m(f.s[J.ankleL]);
      const b = m(f.s[J.ankleR]);
      const cx = (a[0] + b[0]) / 2;
      const cy = (a[1] + b[1]) / 2;
      const spread = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 + 0.40 * mPx;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, spread);
      grad.addColorStop(0, `rgba(3, 7, 9, ${0.55 * alpha})`);
      grad.addColorStop(1, "rgba(3, 7, 9, 0)");
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, 0.30);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, spread, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // What is behind the trunk and what is in front of it. Painter's order over
    // this one split is enough to stop the far arm lying across the chest.
    const trunkDepth = (f.d[J.sternum] + f.d[J.pelvis]) / 2;
    const behind = (from, to) => (f.d[J[from]] + f.d[J[to]]) / 2 > trunkDepth;
    const gripAway = f.d[J.wristR] > trunkDepth;

    const limbs = (list, away, skin) => {
      for (const [from, to, wa, wb] of list) {
        if (behind(from, to) !== away) continue;
        capsule(ctx, P(from), P(to), wa * mPx, wb * mPx, tone(skin, away, 1));
      }
    };

    /** Shoes: a rounded wedge from the ankle over the foot. */
    const shoes = (away) => {
      for (const side of ["L", "R"]) {
        const ankle = "ankle" + side;
        const foot = "foot" + side;
        if (behind(ankle, foot) !== away) continue;
        capsule(ctx, P(ankle), P(foot), 0.050 * mPx, 0.038 * mPx, tone(SHOE, away, 1));
        const t = P(foot);
        ctx.beginPath();
        ctx.arc(t[0], t[1], 0.038 * mPx, 0, Math.PI * 2);
        ctx.fillStyle = tone([40, 52, 58], away, 1);
        ctx.fill();
      }
    };

    /** Shorts over the hips and the top third of each thigh. */
    const shorts = () => {
      for (const side of ["L", "R"]) {
        const hip = P("hip" + side);
        const knee = P("knee" + side);
        capsule(ctx, hip, lerp(hip, knee, 0.42), 0.080 * mPx, 0.068 * mPx,
                tone(SHORTS, behind("hip" + side, "knee" + side), 1));
      }
      // A band across the hips ties the two legs together; a polygon through
      // the hip joints throws spikes whenever they cross in projection.
      capsule(ctx, P("hipL"), P("hipR"), 0.086 * mPx, 0.086 * mPx, tone(SHORTS, false, 1));
    };

    /** The trunk, drawn through the shoulders and hips it actually has. */
    const trunk = () => {
      const sl = P("shoulderL");
      const sr = P("shoulderR");
      const hl = P("hipL");
      const hr = P("hipR");
      const st = P("sternum");
      const pv = P("pelvis");
      // Push each corner outward from the spine so the trunk has bulk, and
      // carry the hem a hand's width below the hips so the shirt is a shirt.
      const out = (p, axis, k) => [p[0] + (p[0] - axis[0]) * k, p[1] + (p[1] - axis[1]) * k];
      const down = lerp(st, pv, 1);
      const hem = (p) => [
        p[0] + (down[0] - st[0]) * 0.05,
        p[1] + (down[1] - st[1]) * 0.05,
      ];
      roundedPoly(ctx, [
        out(sl, st, 0.12), out(sr, st, 0.12), hem(out(hr, pv, 0.06)), hem(out(hl, pv, 0.06)),
      ], 0.105 * mPx);
      ctx.fillStyle = tone(SHIRT, false, 1);
      ctx.fill();
      // Shoulder caps and sleeves.
      for (const side of ["L", "R"]) {
        const sh = P("shoulder" + side);
        const el = P("elbow" + side);
        ctx.beginPath();
        ctx.arc(sh[0], sh[1], 0.068 * mPx, 0, Math.PI * 2);
        ctx.fillStyle = tone(SHIRT, false, 1);
        ctx.fill();
        capsule(ctx, sh, lerp(sh, el, 0.40), 0.062 * mPx, 0.048 * mPx, tone(SHIRT, false, 1));
      }
      // Neck and head.
      capsule(ctx, P("neck"), P("head"), 0.046 * mPx, 0.042 * mPx, tone(SKIN, false, 1));
      const hd = P("head");
      ctx.beginPath();
      ctx.arc(hd[0], hd[1], 0.098 * mPx, 0, Math.PI * 2);
      ctx.fillStyle = tone(SKIN, false, 1);
      ctx.fill();
      // Hair: the cap over the back and top of the skull.
      const nk = P("neck");
      const ang = Math.atan2(hd[1] - nk[1], hd[0] - nk[0]);
      ctx.beginPath();
      ctx.arc(hd[0], hd[1], 0.098 * mPx, ang - Math.PI * 0.95, ang - Math.PI * 0.08);
      ctx.closePath();
      ctx.fillStyle = tone(HAIR, false, 1);
      ctx.fill();
    };

    // Back to front.
    limbs(ARMS, true, SKIN);
    limbs(LEGS, true, SKIN);
    shoes(true);
    limbs(LEGS, false, SKIN);
    shoes(false);
    shorts();
    if (gripAway) racket(ctx, m(f.grip), m(f.head), mPx, alpha, true);
    trunk();
    limbs(ARMS, false, SKIN);
    for (const side of ["L", "R"]) {
      const w = P("wrist" + side);
      ctx.beginPath();
      ctx.arc(w[0], w[1], 0.030 * mPx, 0, Math.PI * 2);
      ctx.fillStyle = tone(SKIN, behind("elbow" + side, "wrist" + side), 1);
      ctx.fill();
    }
    if (!gripAway) racket(ctx, m(f.grip), m(f.head), mPx, alpha, false);

    if (f.ball) {
      const b = m(f.ball);
      const r = Math.max(3, 0.033 * mPx);
      ctx.beginPath();
      ctx.arc(b[0], b[1], r, 0, Math.PI * 2);
      ctx.fillStyle = "#c9dd3c";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b[0] - r * 0.3, b[1] - r * 0.3, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.30)";
      ctx.fill();
    }

    // The machine's reading of the same body, laid over it.
    if (o.markers > 0) {
      ctx.globalAlpha = alpha * o.markers;
      ctx.strokeStyle = "#4dbdb4";
      ctx.lineWidth = Math.max(2, 0.013 * mPx);
      const spine = [["head", "neck"], ["neck", "sternum"], ["sternum", "pelvis"],
                     ["shoulderL", "shoulderR"], ["hipL", "hipR"],
                     ["neck", "shoulderL"], ["neck", "shoulderR"],
                     ["pelvis", "hipL"], ["pelvis", "hipR"]];
      for (const [from, to] of ALL_LIMBS.map((l) => [l[0], l[1]]).concat(spine)) {
        const p = P(from);
        const q = P(to);
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
      }
      for (const name of S.joints) {
        const p = P(name);
        ctx.beginPath();
        ctx.arc(p[0], p[1], Math.max(2.5, 0.018 * mPx), 0, Math.PI * 2);
        ctx.fillStyle = "#eef3f4";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p[0], p[1], Math.max(2.5, 0.018 * mPx), 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(13,20,23,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** A view that places the figure's box at a given height and centre. */
  function makeView(figureHeightPx, centreX, centreY) {
    const box = S.box;
    const scale = figureHeightPx / box.h;
    return {
      scale,
      map: (p) => [
        centreX + (p[0] - box.x - box.w / 2) * scale,
        centreY + (p[1] - box.y - box.h / 2) * scale,
      ],
    };
  }

  window.FIGURE = { drawFigure, makeView };
})();
