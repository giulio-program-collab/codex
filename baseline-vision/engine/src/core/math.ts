/**
 * Deterministic numeric helpers used across all pipeline layers.
 *
 * Everything in this file is pure and dependency-free so that each layer can be
 * unit-tested in isolation and so that a given input video always produces a
 * bit-identical report (a requirement for the regression suite: a report the
 * coach saw yesterday must still be reproducible today).
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add3 = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub3 = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale3 = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const norm3 = (a: Vec3): number => Math.sqrt(dot3(a, a));
export const dist3 = (a: Vec3, b: Vec3): number => norm3(sub3(a, b));

export const cross3 = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export function unit3(a: Vec3): Vec3 {
  const n = norm3(a);
  return n < 1e-12 ? v3(0, 0, 0) : scale3(a, 1 / n);
}

export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export const mid3 = (a: Vec3, b: Vec3): Vec3 => lerp3(a, b, 0.5);

export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

/** Interior angle A-B-C in degrees, computed on 3D points. */
export function angle3(a: Vec3, b: Vec3, c: Vec3): number | null {
  const u = sub3(a, b);
  const w = sub3(c, b);
  const nu = norm3(u);
  const nw = norm3(w);
  if (nu < 1e-9 || nw < 1e-9) return null;
  return deg(Math.acos(clamp(dot3(u, w) / (nu * nw), -1, 1)));
}

/** Angle between two 3D directions, in degrees, always in [0, 180]. */
export function angleBetween(a: Vec3, b: Vec3): number | null {
  const na = norm3(a);
  const nb = norm3(b);
  if (na < 1e-9 || nb < 1e-9) return null;
  return deg(Math.acos(clamp(dot3(a, b) / (na * nb), -1, 1)));
}

/**
 * Signed rotation of `v` around `axis`, measured from `refDir`, in degrees.
 * Used for hip/shoulder rotation about the vertical axis, where the sign
 * carries the coaching meaning (open vs. closed).
 */
export function signedAngleAround(v: Vec3, refDir: Vec3, axis: Vec3): number | null {
  const n = unit3(axis);
  const proj = (p: Vec3): Vec3 => sub3(p, scale3(n, dot3(p, n)));
  const a = proj(refDir);
  const b = proj(v);
  if (norm3(a) < 1e-9 || norm3(b) < 1e-9) return null;
  const ang = angleBetween(a, b);
  if (ang === null) return null;
  return dot3(cross3(a, b), n) < 0 ? -ang : ang;
}

/* ------------------------------------------------------------------ */
/* Descriptive statistics                                              */
/* ------------------------------------------------------------------ */

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Sample standard deviation (n-1). Returns null for fewer than two values. */
export function sd(xs: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs) as number;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Median absolute deviation, scaled to be a consistent estimator of sigma. */
export function mad(xs: readonly number[]): number | null {
  const m = median(xs);
  if (m === null) return null;
  const devs = xs.map((x) => Math.abs(x - m));
  const raw = median(devs);
  return raw === null ? null : raw * 1.4826;
}

export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 based erf approximation). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/* ------------------------------------------------------------------ */
/* Deterministic pseudo-randomness                                     */
/* ------------------------------------------------------------------ */

/**
 * Small-state xorshift PRNG. Every stochastic step in the pipeline (Monte-Carlo
 * uncertainty propagation, RANSAC-style fitting) draws from a seeded instance so
 * that reports are reproducible.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }

  /** Standard normal via Box-Muller. */
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  gauss(mu: number, sigma: number): number {
    return mu + sigma * this.normal();
  }

  int(loInclusive: number, hiExclusive: number): number {
    return loInclusive + Math.floor(this.next() * (hiExclusive - loInclusive));
  }
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Zero-phase moving average. Zero phase matters: a causal filter would shift
 * every event in time, and the whole point of the kinetic-chain analysis is the
 * few-millisecond lag between segment peaks.
 */
export function smooth(xs: readonly number[], halfWidth: number): number[] {
  if (halfWidth <= 0) return [...xs];
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    let s = 0;
    let n = 0;
    for (let k = -halfWidth; k <= halfWidth; k++) {
      const j = i + k;
      if (j < 0 || j >= xs.length) continue;
      s += xs[j];
      n++;
    }
    out.push(s / n);
  }
  return out;
}

/**
 * Zero-phase second-order Butterworth low-pass, applied forward and backward.
 *
 * This is the standard tool of the trade in biomechanics (Winter, ch. 3) and it
 * is not optional here. Joint-angle series reconstructed from a monocular view
 * carry depth noise that is nearly independent between frames; differentiating
 * such a series amplifies that noise by the sampling rate, so an unfiltered
 * "peak angular velocity" from 120 Hz data is mostly a measurement of the noise.
 * Filtering forward and backward cancels the phase lag, which matters because
 * the timing of the peak is itself an output.
 *
 * `cutoffHz` should be chosen from the signal, not from habit: 6-8 Hz suits
 * gait, 12-20 Hz is appropriate for the trunk and pelvis in a serve, and the
 * racket needs more. A cutoff that is too low does not merely smooth, it moves
 * peaks and shrinks them.
 */
export function butterworthLowPass(xs: readonly number[], cutoffHz: number, sampleHz: number): number[] {
  const n = xs.length;
  if (n < 6 || cutoffHz <= 0 || cutoffHz >= sampleHz / 2) return [...xs];
  // Correction for the double pass, so the effective cutoff is the requested one.
  const corrected = cutoffHz / 0.802;
  const wc = Math.tan((Math.PI * corrected) / sampleHz);
  const k1 = Math.SQRT2 * wc;
  const k2 = wc * wc;
  const a0 = k2 / (1 + k1 + k2);
  const a1 = 2 * a0;
  const a2 = a0;
  const b1 = (2 * (k2 - 1)) / (1 + k1 + k2);
  const b2 = (1 - k1 + k2) / (1 + k1 + k2);

  const pass = (input: readonly number[]): number[] => {
    const out = new Array<number>(input.length);
    let x1 = input[0];
    let x2 = input[0];
    let y1 = input[0];
    let y2 = input[0];
    for (let i = 0; i < input.length; i++) {
      const x0 = input[i];
      const y0 = a0 * x0 + a1 * x1 + a2 * x2 - b1 * y1 - b2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return out;
  };

  const forward = pass(xs);
  const backward = pass([...forward].reverse());
  return backward.reverse();
}

/**
 * Central-difference derivative on a uniformly sampled signal.
 * `dt` is the sample interval in seconds; the result carries the unit of `xs`
 * per second.
 */
export function derivative(xs: readonly number[], dt: number): number[] {
  const n = xs.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (i === 0) out[i] = (xs[1] - xs[0]) / dt;
    else if (i === n - 1) out[i] = (xs[n - 1] - xs[n - 2]) / dt;
    else out[i] = (xs[i + 1] - xs[i - 1]) / (2 * dt);
  }
  return out;
}

/**
 * Index of the maximum of a signal, refined to sub-sample resolution by fitting
 * a parabola through the peak and its two neighbours.
 *
 * Sub-sample refinement is not cosmetic here. At 60 fps one frame is 16.7 ms,
 * and the elite/high-performance difference in pelvis-to-contact timing is
 * roughly 18 ms — barely one frame. Without refinement, timing differences of
 * that size are pure quantisation noise.
 */
export function refinedPeak(xs: readonly number[]): { index: number; value: number } | null {
  if (xs.length === 0) return null;
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  if (best === 0 || best === xs.length - 1) return { index: best, value: xs[best] };
  const y0 = xs[best - 1];
  const y1 = xs[best];
  const y2 = xs[best + 1];
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < 1e-12) return { index: best, value: y1 };
  const delta = clamp((0.5 * (y0 - y2)) / denom, -1, 1);
  return { index: best + delta, value: y1 - 0.25 * (y0 - y2) * delta };
}

/** Linear interpolation of a sampled signal at a fractional index. */
export function sampleAt(xs: readonly number[], index: number): number | null {
  if (xs.length === 0) return null;
  const i = clamp(index, 0, xs.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, xs.length - 1);
  return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
}
