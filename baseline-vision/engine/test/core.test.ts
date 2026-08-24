import test from "node:test";
import assert from "node:assert/strict";

import {
  Rng,
  angle3,
  butterworthLowPass,
  derivative,
  normalCdf,
  refinedPeak,
  signedAngleAround,
  v3,
} from "../src/core/math.ts";
import { backproject, focalFromHfov, inPlaneFraction, lookAt, project, unproject } from "../src/core/camera.ts";
import { scatterMatrix, symmetricEigen3 } from "../src/core/linalg.ts";
import {
  interval,
  measureFrom,
  posteriorSanity,
  probabilityBeyond,
} from "./helpers.ts";

test("angle3 measures interior angles", () => {
  assert.equal(angle3(v3(1, 0, 0), v3(0, 0, 0), v3(0, 1, 0)), 90);
  const straight = angle3(v3(1, 0, 0), v3(0, 0, 0), v3(-1, 0, 0));
  assert.ok(straight !== null && Math.abs(straight - 180) < 1e-9);
});

test("signedAngleAround carries the direction of rotation", () => {
  const a = signedAngleAround(v3(0, 1, 0), v3(1, 0, 0), v3(0, 0, 1));
  const b = signedAngleAround(v3(0, -1, 0), v3(1, 0, 0), v3(0, 0, 1));
  assert.ok(a !== null && b !== null);
  assert.ok(Math.abs((a as number) - 90) < 1e-6);
  assert.ok(Math.abs((b as number) + 90) < 1e-6);
});

test("projection and back-projection round-trip", () => {
  const cam = lookAt(v3(6, -4, 1.7), v3(0, 0, 1.4), focalFromHfov(60, 1920), 1920, 1080);
  const world = v3(0.4, 0.3, 2.1);
  const pr = project(cam, world);
  assert.ok(pr.inFrame);
  const back = unproject(cam, pr.p, 0);
  void back;
  const ray = backproject(cam, pr.p);
  // The world point must lie along the recovered ray from the camera centre.
  const toPoint = v3(world.x - cam.position.x, world.y - cam.position.y, world.z - cam.position.z);
  const len = Math.hypot(toPoint.x, toPoint.y, toPoint.z);
  for (const axis of ["x", "y", "z"] as const) {
    assert.ok(Math.abs(ray[axis] * len - toPoint[axis]) < 1e-6);
  }
});

test("inPlaneFraction is 1 across the view axis and 0 along it", () => {
  const cam = lookAt(v3(0, -5, 0), v3(0, 0, 0), 1000, 1920, 1080);
  assert.ok(Math.abs(inPlaneFraction(cam, v3(1, 0, 0)) - 1) < 1e-9);
  assert.ok(inPlaneFraction(cam, v3(0, 1, 0)) < 1e-6);
});

test("refinedPeak locates a peak between samples", () => {
  // Parabola peaking at index 2.5.
  const xs = [0, 1, 2, 2, 1, 0].map((_, i) => -((i - 2.5) ** 2));
  const pk = refinedPeak(xs);
  assert.ok(pk !== null);
  assert.ok(Math.abs((pk as { index: number }).index - 2.5) < 0.05);
});

test("butterworth low-pass is zero-phase", () => {
  // A pulse must stay centred where it was; a causal filter would shift it.
  const n = 200;
  const xs = Array.from({ length: n }, (_, i) => Math.exp(-((i - 100) ** 2) / 50));
  const filtered = butterworthLowPass(xs, 10, 200);
  const pk = refinedPeak(filtered);
  assert.ok(pk !== null);
  assert.ok(Math.abs((pk as { index: number }).index - 100) < 1.0);
});

test("butterworth low-pass suppresses noise far above the cutoff", () => {
  const rng = new Rng(7);
  const n = 400;
  const clean = Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 2 * i) / 200));
  const noisy = clean.map((v) => v + rng.gauss(0, 0.4));
  const filtered = butterworthLowPass(noisy, 8, 200);
  const err = (a: number[]) =>
    Math.sqrt(a.reduce((s, v, i) => s + (v - clean[i]) ** 2, 0) / n);
  assert.ok(err(filtered) < err(noisy) * 0.5, "filter must at least halve the error");
});

test("derivative of a filtered signal recovers the true rate", () => {
  const hz = 240;
  const n = 240;
  const xs = Array.from({ length: n }, (_, i) => 30 * (i / hz)); // 30 deg/s ramp
  const d = derivative(butterworthLowPass(xs, 12, hz), 1 / hz);
  const mid = d.slice(40, n - 40);
  for (const v of mid) assert.ok(Math.abs(v - 30) < 0.5);
});

test("normalCdf matches known values", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
});

test("symmetricEigen3 finds the direction orthogonal to a set of vectors", () => {
  // Vectors spanning the xy plane: the smallest principal direction is z.
  const dirs = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * Math.PI;
    return v3(Math.cos(a), Math.sin(a), 0);
  });
  const eig = symmetricEigen3(scatterMatrix(dirs));
  const smallest = eig.vectors[2];
  assert.ok(Math.abs(Math.abs(smallest.z) - 1) < 1e-6);
});

test("Rng is deterministic and reproducible", () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 50; i++) assert.equal(a.next(), b.next());
});

test("measures carry an uncertainty floor", () => {
  const m = measureFrom({ value: 10, sd: 0.0001, validFraction: 1 }, {
    unit: "°",
    observability: "reconstructed",
    provenance: ["test"],
    trust: [{ label: "test", value: 1 }],
    sdFloor: 2,
  });
  assert.equal(m.sd, 2, "an implausibly small spread must be floored");
});

test("confidence interval and tail probability agree", () => {
  const m = measureFrom({ value: 100, sd: 10, validFraction: 1 }, {
    unit: "°",
    observability: "reconstructed",
    provenance: ["test"],
    trust: [{ label: "t", value: 1 }],
  });
  const iv = interval(m);
  assert.ok(iv !== null);
  assert.ok(Math.abs((iv as [number, number])[0] - 80.4) < 0.2);
  const p = probabilityBeyond(m, 120, "above");
  assert.ok(p !== null && Math.abs((p as number) - 0.0228) < 0.005);
});

test("posterior out-of-plane estimate shrinks toward zero when the projection is uninformative", () => {
  const L = 0.45;
  // Projection equal to the full bone length: the bone lies in the image plane.
  const sharp = posteriorSanity(L, L, 0.002);
  const vague = posteriorSanity(L, L, 0.05);
  assert.ok(sharp.mean < vague.mean, "more noise must widen, not sharpen, the estimate");
  assert.ok(sharp.mean < 0.1 * L, "a well-measured in-plane bone must not gain depth");
  // A clearly foreshortened bone must recover its depth.
  const foreshortened = posteriorSanity(L, 0.6 * L, 0.004);
  const expected = L * Math.sqrt(1 - 0.36);
  assert.ok(Math.abs(foreshortened.mean - expected) < 0.05 * L);
});
