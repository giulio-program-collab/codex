/**
 * Screens of the app actually running, for the film to fly into.
 *
 * The advertisement shows the product, not a drawing of it: these are the
 * playground's own panels on its own simulated serve, rendered in an 1100 CSS
 * pixel viewport at twice the device scale — so at the size the film puts them
 * on screen, the type is still the type a user reads.
 *
 * Serve the playground first, from `engine/`:
 *
 *     node --experimental-strip-types tools/serve.ts
 *
 * then run this from `ad/`. It overwrites `app-verdict.png` and
 * `app-metrics.png`, which `build-ad.mjs` embeds into the film.
 */
import { chromium } from "playwright";

const URL = process.env.PLAYGROUND || "http://localhost:8099/index.html";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({
  viewport: { width: 1100, height: 900 },
  deviceScaleFactor: 2,
  // The film is dark; a screen photographed in the light theme would arrive in
  // it as a white rectangle.
  colorScheme: "dark",
});
await page.goto(URL, { waitUntil: "load" });

// The page computes its analysis in the browser; nothing is prepared. Wait for
// the verdict to stop being a placeholder before photographing anything.
await page.waitForFunction(
  () => {
    const s = document.getElementById("verdict-statement");
    const m = document.getElementById("metrics");
    return s && s.textContent.trim().length > 3 && m && m.children.length > 0;
  },
  null,
  { timeout: 60000 },
);
await page.evaluate(() => {
  // The masthead is sticky and would print a band across every panel; the
  // control rail is not what the film is about, and taking it away lets the
  // panels use the full width, which is what makes their type legible once
  // they are scaled down into a window inside a 1920-pixel frame.
  const head = document.querySelector("body > header");
  if (head) head.style.display = "none";
  const rail = document.querySelector(".rail");
  if (rail) rail.style.display = "none";
  const shell = document.querySelector(".shell");
  if (shell) shell.style.gridTemplateColumns = "minmax(0, 1fr)";
});
await page.waitForTimeout(500);

/**
 * The film frames one part of each screen and dims the rest. Which part is
 * measured here, from the live page, and written out next to the pictures — so
 * a re-capture that reflows the layout moves the frame with it instead of
 * leaving a rectangle pointing at the wrong row.
 */
const DPR = 2;
const regions = {};

for (const [name, heading, of] of [
  ["verdict", "Ergebnis", ".quality"],
  ["metrics", "Messwerte", "#metrics > *:first-child"],
]) {
  const panel = page.locator(`section.panel:has(header h2:text-is("${heading}"))`).first();
  await panel.screenshot({ path: `app-${name}.png` });
  const box = await panel.boundingBox();
  const inner = await page.locator(of).first().boundingBox();
  const pad = 10;
  regions[name] = [
    Math.round((inner.x - box.x - pad) * DPR),
    Math.round((inner.y - box.y - pad) * DPR),
    Math.round((inner.x - box.x + inner.width + pad) * DPR),
    Math.round((inner.y - box.y + inner.height + pad) * DPR),
  ];
  console.log(
    `app-${name}.png  ${Math.round(box.width * DPR)}×${Math.round(box.height * DPR)} px`
    + `  Ausschnitt ${regions[name].join(", ")}`,
  );
}

/**
 * And the numbers themselves.
 *
 * The film says out loud what is on the screen behind it. Reading those figures
 * off the same run that produced the pictures is the only way the two cannot
 * drift apart — an advertisement quoting a measurement its own screenshot does
 * not show is the exact failure this project exists to argue against.
 */
const facts = await page.evaluate(() => {
  const row = document.querySelector("#metrics > *:first-child");
  const score = document.querySelector(".quality");
  // The report itself, rather than a phrase scraped off the page: the wording
  // around these numbers changes, the numbers are the numbers.
  const report = window.Playground.currentReport();
  return {
    metricName: row.querySelector(".name").firstChild.textContent.trim(),
    metricValue: row.querySelector(".value > div").textContent.trim(),
    usable: report.verdict.measured.usable + " von " + report.verdict.measured.total,
    quality: (score.textContent.match(/\b(\d{1,3})\s*\/\s*100/) || [, ""])[1],
  };
});
console.log(facts);

const { writeFileSync } = await import("node:fs");
writeFileSync("app-capture.json", JSON.stringify({ regions, facts }, null, 2) + "\n");
await browser.close();
