import { chromium } from "playwright";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const FPS = 30;
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 200)));
await page.addInitScript(() => { window.__RECORDING = true; });
await page.goto("file://" + process.cwd() + "/ad.html", { waitUntil: "load" });
await page.evaluate(() => window.adReady);
const duration = await page.evaluate(() => window.AD_DURATION);
const total = Math.round(duration * FPS);
console.log(`recording ${total} frames at ${FPS} fps (${duration}s)`);

// Frames go straight into the encoder; a thousand PNGs on disk is a quarter of
// a gigabyte for no reason.
const ff = spawn(ffmpegPath, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "17",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  "baseline-vision-ad.mp4",
]);
ff.stderr.on("data", (d) => process.stderr.write(d));

const started = Date.now();
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.setT(t), i / FPS);
  const buf = await page.screenshot({ type: "png" });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 60 === 0) {
    const per = (Date.now() - started) / (i + 1);
    console.log(`  ${i}/${total} · noch ca. ${Math.round((per * (total - i)) / 1000)} s`);
  }
}
ff.stdin.end();
await new Promise((resolve) => ff.on("close", resolve));
await browser.close();
console.log("fertig");
