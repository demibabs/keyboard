// E2E: play a level through the YouTube embed and check the clock follows the video.
// usage: node e2e/youtube.mjs [levelId=twilight-zone] [speed=1]   (needs `npx vite` running on :5173)
import { chromium } from "playwright";
import fs from "node:fs";
const id = process.argv[2] ?? "twilight-zone";
const speed = Number(process.argv[3] ?? 1);
fs.mkdirSync("e2e/out", { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto("http://localhost:5173/#/play");
await page.evaluate(([id, s]) => localStorage.setItem("startype:settings", JSON.stringify({ speed: s, levelId: id, audioSource: "youtube", volume: 0.8 })), [id, speed]);
await page.reload();
await page.waitForSelector(".sm-row");
await page.screenshot({ path: "e2e/out/yt-select.png" });
await page.keyboard.press("Enter"); // the menu starts on settings.levelId
const t0 = Date.now();
await page.waitForTimeout(1500);
await page.screenshot({ path: "e2e/out/yt-prep.png" });
await page.waitForFunction(() => window.__play, null, { timeout: 90000 });
console.log(`ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.waitForTimeout(3000);
await page.evaluate(() => window.__play.skip());
// sample our clock vs the video's reported time
const rows = [];
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(200);
  rows.push(await page.evaluate(() => {
    const p = window.__play.player;
    const yt = window.YT && document.querySelector(".yt-host iframe") ? p.p : null;
    return { ours: p.time(), video: yt?.getCurrentTime(), rate: yt?.getPlaybackRate(), state: yt?.getPlayerState() };
  }));
}
const off = rows.map((r) => r.video / speed - r.ours); // (video - offset)/speed - ours, with offset 0
console.log("rate", rows[0].rate, "state", rows.at(-1).state);
console.log("ours - video (ms):", off.map((d) => Math.round(-d * 1000)).join(" "));
const steps = rows.slice(1).map((r, i) => r.ours - rows[i].ours);
console.log("clock steps (ms):", steps.map((d) => Math.round(d * 1000)).join(" "));
await page.screenshot({ path: "e2e/out/yt-play.png" });
await browser.close();
