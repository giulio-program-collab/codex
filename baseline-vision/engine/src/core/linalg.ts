import { type Vec3, unit3, v3 } from "./math.ts";

/**
 * Eigen-decomposition of a symmetric 3x3 matrix by cyclic Jacobi rotations.
 *
 * Used for the two places where the pipeline needs a principal direction:
 * recovering the vertical from a set of vectors that are all known to be
 * horizontal, and fitting a plane to a set of points. Three-by-three is small
 * enough that Jacobi converges in a handful of sweeps and needs no library.
 */
export interface Eigen3 {
  /** Column i of `vectors` is the eigenvector for `values[i]`, sorted descending. */
  vectors: Vec3[];
  values: number[];
}

export function symmetricEigen3(m: number[][]): Eigen3 {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-20) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = [a[0][0], a[1][1], a[2][2]];
  const order = [0, 1, 2].sort((x, y) => values[y] - values[x]);
  return {
    vectors: order.map((o) => unit3(v3(v[0][o], v[1][o], v[2][o]))),
    values: order.map((o) => values[o]),
  };
}

/** Scatter matrix of a set of directions, for principal-direction fitting. */
export function scatterMatrix(dirs: readonly Vec3[]): number[][] {
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const d of dirs) {
    const c = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += c[i] * c[j];
  }
  return m;
}
