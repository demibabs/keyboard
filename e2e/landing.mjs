// Screenshots of the landing page at a few sizes (dev server on :5173).
import { chromium } from "playwright";
import fs from "node:fs";
fs.mkdirSync("e2e/out", { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
for (const [w, hgt, wait] of [[1440, 900, 5200], [1100, 800, 4000], [390, 844, 4000]]) {
  const page = await browser.newPage({ viewport: { width: w, height: hgt } });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto("http://localhost:5173/");
  await page.waitForSelector(".hero-play");
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `e2e/out/landing-${w}.png` });
  console.log(w, "cards:", await page.locator(".lyric-card").count(), "overflowX:", await page.evaluate(() => document.querySelector(".landing").scrollWidth > innerWidth));
  await page.close();
}
await browser.close();
