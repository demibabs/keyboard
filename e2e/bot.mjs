// E2E: a bot plays a level by typing at the charted times, then we check the results and grab screenshots.
// usage: [YT=1] node e2e/bot.mjs [speed=1.5] [jitterMs=0]   (needs `npx vite` running on :5173; YT=1 plays the YouTube video)
import { chromium } from "playwright";
import fs from "node:fs";
const speed = Number(process.argv[2] ?? 1.5);
const jitter = Number(process.argv[3] ?? 0) / 1000;
const sloppy = process.argv[4] === "sloppy"; // skips syllables, abandons words, typos
const shifty = process.argv[4] === "shifty"; // only single-letter slips: skipped, doubled or wrong letters
fs.mkdirSync("e2e/out", { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto("http://localhost:5173/");
await page.waitForSelector(".song-card");
await page.evaluate(([s, src]) => localStorage.setItem("startype:settings", JSON.stringify({ speed: s, audioOffsetMs: 0, visualOffsetMs: 0, levelId: "twilight-zone", volume: 0.8, audioSource: src })), [speed, process.env.YT ? "youtube" : "local"]);
await page.reload();
await page.waitForSelector(".song-card");
await page.screenshot({ path: "e2e/out/select.png" });
await page.keyboard.press("Enter");
await page.waitForFunction(() => (window).__play, null, { timeout: 90000 });
// skip the intro, then let the in-page bot type
await page.waitForTimeout(500);
await page.evaluate(() => (window).__play.skip());
const shotAt = await page.evaluate(({ jitter, sloppy, shifty }) => {
  const { engine, player, aOff } = window.__play;
  const { chars } = engine.flat;
  const plan = [];
  engine.lines.forEach((l, i) => {
    const t0 = engine.onset(i) + (Math.random() * 2 - 1) * jitter;
    const n = l.end - l.first;
    const step = Math.min(0.07, (engine.deadline(i) - t0 - 0.1) / n);
    let t = t0;
    for (let k = 0; k < n; k++) {
      if (sloppy && k > 0 && Math.random() < 0.08) break; // give up on the rest of the line
      if (shifty && k > 0 && Math.random() < 0.03) { window.__slips = (window.__slips ?? 0) + 1; continue; } // skipped letter
      const ch = (sloppy || shifty) && Math.random() < 0.04 ? "q" : chars[l.first + k].ch;
      plan.push([t, ch]);
      if (shifty && Math.random() < 0.02) { window.__slips = (window.__slips ?? 0) + 1; plan.push([t + 0.005, ch]); } // doubled letter
      t += step;
    }
  });
  let i = 0;
  const tick = () => {
    const now = player.time() - aOff;
    while (i < plan.length && plan[i][0] <= now) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: plan[i][1], bubbles: true }));
      i++;
    }
    if (i < plan.length) setTimeout(tick, 1);
  };
  tick();
  return engine.onset(6) + 1.2;
}, { jitter, sloppy, shifty });
// screenshot mid-song
while (await page.evaluate((t) => (window).__play.player.time() < t, shotAt)) await page.waitForTimeout(100);
await page.screenshot({ path: "e2e/out/play.png" });
await page.waitForSelector(".results", { timeout: 400000 });
await page.waitForTimeout(400);
await page.screenshot({ path: "e2e/out/results.png", fullPage: true });
const res = await page.evaluate(() => [...document.querySelectorAll(".res-row")].map((r) => r.textContent).join("\n") + "\nscore " + document.querySelector(".big-score").textContent + " grade " + document.querySelector(".grade").textContent);
console.log(res);
console.log("slips", await page.evaluate(() => (window).__slips ?? 0), "resyncs", await page.evaluate(() => (window).__resyncs ?? 0));
await page.keyboard.press("Enter");
await page.waitForSelector(".song-card");
await page.keyboard.press("c");
await page.waitForSelector(".calibrate");
await page.screenshot({ path: "e2e/out/calibrate.png" });
await page.keyboard.press("Escape");
await page.waitForSelector(".song-card");
await page.keyboard.press("e");
await page.waitForSelector(".ed-canvas");
await page.waitForTimeout(800);
await page.screenshot({ path: "e2e/out/editor.png" });
await browser.close();
