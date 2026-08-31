/**
 * Re-exports so tests import from one place, plus a couple of thin wrappers
 * that keep the test files readable.
 */
export { combineTrust, interval, measureFrom, probabilityBeyond } from "../src/core/uncertainty.ts";
export { posteriorOutOfPlane as posteriorSanity } from "../src/layers/l06-lift3d.ts";

import type { AnalysisReport } from "../src/layers/l14-report.ts";

/** Convenience accessor used throughout the acceptance tests. */
export function metric(report: AnalysisReport, id: string) {
  return report.metrics.find((m) => m.id === id) ?? null;
}

export function hasBlockingIssue(report: AnalysisReport, idPrefix: string): boolean {
  return report.issues.some((i) => i.severity === "blocking" && i.id.startsWith(idPrefix));
}

export function issueIds(report: AnalysisReport): string[] {
  return report.issues.map((i) => i.id);
}
