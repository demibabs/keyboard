// Level files. Run with Node 23.6+ (type stripping):
//   node scripts/levels.ts sync           chart.json -> level.json for every local chart; writes index.json + local.json
//   node scripts/levels.ts verify [ids]   fetch each level's lyrics from LRCLIB and check they match the timing
//   node scripts/levels.ts youtube <id> <videoId> [offsetMs] [durationSec]   set a level's video
//
// public/levels/<id>/chart.json (full text) and audio@*.ogg are local only; level.json, index.json are committed.
import fs from "node:fs";
import path from "node:path";
import { cleanLines, levelOf, textHash, type Level, type YouTubeRef } from "../src/lyrics.ts";
import type { Chart } from "../src/chart.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "public", "levels");
const SPEEDS = ["0.50", "0.75", "1.00", "1.25", "1.50"];
const UA = "startype/0.1 (typing rhythm game)";

const file = (id: string, name: string) => path.join(ROOT, id, name);
const readJson = <T>(p: string): T | undefined => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined);
const dirs = () => fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()).sort();
const hasAudio = (id: string) => SPEEDS.every((s) => fs.existsSync(file(id, `audio@${s}.ogg`)));

/** JSON with one lyric line per row. */
function format(level: Level): string {
  const rows = level.lines.map((l) => "  " + JSON.stringify(l)).join(",\n");
  return JSON.stringify({ ...level, lines: "@LINES@" }, null, 1).replace('"@LINES@"', `[\n${rows}\n ]`) + "\n";
}
function writeIfChanged(p: string, text: string): boolean {
  if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === text) return false;
  fs.writeFileSync(p, text);
  return true;
}

export function sync(only?: string[]): void {
  let changed = 0;
  for (const id of dirs()) {
    const chart = readJson<Chart>(file(id, "chart.json"));
    if (!chart || (only && !only.includes(id))) continue;
    const old = readJson<Level>(file(id, "level.json"));
    const yt: YouTubeRef | undefined = chart.youtube ?? old?.youtube;
    if (writeIfChanged(file(id, "level.json"), format(levelOf(chart, yt)))) changed++;
  }
  const levels = dirs().filter((id) => {
    const l = readJson<Level>(file(id, "level.json"));
    return l && (l.youtube || hasAudio(id));
  });
  writeIfChanged(path.join(ROOT, "index.json"), JSON.stringify({ levels }) + "\n");
  writeIfChanged(path.join(ROOT, "local.json"), JSON.stringify({ levels: levels.filter(hasAudio) }) + "\n");
  console.log(`levels: ${levels.length} listed, ${changed} level.json written`);
}

async function verify(ids: string[]): Promise<void> {
  const todo = (ids.length ? ids : dirs()).filter((id) => fs.existsSync(file(id, "level.json")));
  const bad: string[] = [];
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const id = todo[next++];
      const level = readJson<Level>(file(id, "level.json"))!;
      let lrc = "";
      for (let tries = 0; tries < 5 && !lrc; tries++) {
        try {
          const r = await fetch(`https://lrclib.net/api/get/${level.lyrics.lrclib}`, { headers: { "User-Agent": UA } });
          if (r.ok) lrc = (await r.json()).syncedLyrics ?? "";
          else if (r.status === 404) break;
        } catch { /* retry */ }
        if (!lrc) await new Promise((res) => setTimeout(res, 1000 * 2 ** tries));
      }
      const lines = lrc ? cleanLines(lrc) : [];
      const problem = !lrc ? "no lyrics from LRCLIB"
        : lines.length !== level.lines.length ? `line count ${lines.length} vs ${level.lines.length}`
        : textHash(lines) !== level.lyrics.hash ? "text differs" : "";
      if (problem) bad.push(`${id}: ${problem}`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`${todo.length} checked, ${bad.length} problems`);
  bad.forEach((b) => console.log("  " + b));
  if (bad.length) process.exitCode = 1;
}

function setYouTube(id: string, video: string, offsetMs = 0, duration?: number): void {
  const yt: YouTubeRef = { id: video, offsetMs };
  if (duration) yt.duration = duration;
  for (const name of ["chart.json", "level.json"]) {
    const p = file(id, name);
    const d = readJson<Record<string, unknown>>(p);
    if (!d) continue;
    d.youtube = yt;
    fs.writeFileSync(p, name === "level.json" ? format(d as unknown as Level) : JSON.stringify(d, null, 1));
  }
  sync([id]);
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "sync") sync(args.length ? args : undefined);
  else if (cmd === "verify") await verify(args);
  else if (cmd === "youtube" && args.length >= 2) setYouTube(args[0], args[1], Number(args[2] ?? 0), args[3] ? Number(args[3]) : undefined);
  else { console.error("usage: node scripts/levels.ts sync | verify [ids] | youtube <id> <videoId> [offsetMs] [durationSec]"); process.exit(2); }
}
