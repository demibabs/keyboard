// Levels ship without lyric text: public/levels/<id>/level.json holds the LRCLIB entry id, our line timing,
// per-line typed-character counts (for the song list) and the YouTube video. The text is fetched from
// LRCLIB when a song is played and checked against a hash of the text the timing was made for.
// No DOM here (scripts/levels.ts runs this in Node too).
import { flatten, type Chart, type ChartLine } from "./chart.ts";

export interface YouTubeRef {
  id: string; // video id
  offsetMs: number; // video time of chart time 0 (positive: the video has extra intro)
  duration?: number; // video length, seconds (tells the song apart from ads)
}

export interface Level {
  format: 3;
  id: string;
  version: number;
  title: string;
  artist: string;
  duration: number;
  offsetMs: number;
  lyrics: { lrclib: number; lines: number; hash: string };
  /** per cleaned LRC line: [start (chart seconds), typed characters]; 0 = blank (end of vocals), -1 = nothing to type */
  lines: [number, number][];
  youtube?: YouTubeRef;
  source?: string;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const NEWLINE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/; // what Python's splitlines() splits on
const STAMP = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

/** "[mm:ss.xx] text" lines -> [{t, text}] sorted by time; a line may carry several timestamps. */
export function parseLrc(lrc: string): ChartLine[] {
  const out: ChartLine[] = [];
  for (const raw of lrc.split(NEWLINE)) {
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue; // metadata tags like [ar:...] or junk
    const text = raw.replace(STAMP, "").trim();
    for (const m of stamps) out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000) / 1000, text });
  }
  return out.sort((a, b) => a.t - b.t); // stable, like Python's sort
}

/** LRC -> chart lines: drop leading blanks and collapse repeated blanks (blank = end-of-vocals marker).
 * Same as clean_lines() in charting/make_level.py. */
export function cleanLines(lrc: string): ChartLine[] {
  const out: ChartLine[] = [];
  for (const l of parseLrc(lrc)) {
    if (!l.text && (!out.length || !out[out.length - 1].text)) continue;
    out.push(l);
  }
  return out;
}

/** FNV-1a (32-bit) of the lines' text, UTF-8, joined by newlines. */
export function textHash(lines: { text: string }[]): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(lines.map((l) => l.text).join("\n"))) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** level.json for a full local chart (scripts/levels.ts). */
export function levelOf(chart: Chart, youtube?: YouTubeRef): Level {
  const m = /^lrclib:(\d+)/.exec(chart.source ?? "");
  if (!m) throw new Error(`${chart.id}: source isn't an LRCLIB entry (${chart.source})`);
  const counts = new Map(flatten(chart).lines.map((l) => [l.chartIndex, l.end - l.first]));
  const level: Level = {
    format: 3, id: chart.id, version: chart.version, title: chart.title, artist: chart.artist,
    duration: chart.duration, offsetMs: chart.offsetMs,
    lyrics: { lrclib: Number(m[1]), lines: chart.lines.length, hash: textHash(chart.lines) },
    lines: chart.lines.map((l, i) => [l.t, counts.get(i) ?? (l.text.trim() ? -1 : 0)]),
  };
  if (youtube) level.youtube = youtube;
  if (chart.source) level.source = chart.source;
  return level;
}

function baseChart(level: Level, lines: ChartLine[]): Chart {
  return {
    format: 2, id: level.id, version: level.version, title: level.title, artist: level.artist,
    duration: level.duration, offsetMs: level.offsetMs, speeds: SPEEDS, audio: "audio@{speed}.ogg",
    source: level.source, youtube: level.youtube, lines,
  };
}

/** Stand-in chart with placeholder text of the right length: enough for the song list (difficulty, line count). */
export function skeleton(level: Level): Chart {
  return baseChart(level, level.lines.map(([t, n]) => ({ t, text: n > 0 ? "a".repeat(n) : n < 0 ? "(-)" : "" })));
}

/** The playable chart: LRCLIB's text with the level's timing. If LRCLIB's entry has changed since the level
 * was timed, the text is used anyway; with a different number of lines, LRCLIB's own timing is used. */
export function chartWithLyrics(level: Level, lrc: string): Chart {
  const lines = cleanLines(lrc);
  const chart = baseChart(level, lines);
  if (lines.length === level.lines.length) {
    lines.forEach((l, i) => (l.t = level.lines[i][0]));
    if (textHash(lines) !== level.lyrics.hash) console.warn(`${level.id}: LRCLIB's text changed since this level was timed`);
  } else {
    chart.note = "LRCLIB's lyrics for this song changed since it was timed, so the timing may be off.";
  }
  return chart;
}

// ---------- fetching (browser) ----------
const API = "https://lrclib.net/api/get/";
const CACHE = "keyboard:lrc:";

async function fetchLrc(id: number): Promise<string> {
  let r: Response;
  try {
    r = await fetch(API + id);
  } catch {
    throw new Error("Couldn't reach LRCLIB (lrclib.net) for the lyrics. Check your connection.");
  }
  if (!r.ok) throw new Error(`LRCLIB couldn't provide the lyrics (entry ${id}, HTTP ${r.status}).`);
  const lrc = (await r.json()).syncedLyrics;
  if (!lrc) throw new Error(`LRCLIB entry ${id} has no synced lyrics anymore.`);
  return lrc;
}

/** Lyrics for a level (from this browser's cache when they still match the level). */
export async function loadLyrics(level: Level): Promise<Chart> {
  const key = CACHE + level.lyrics.lrclib;
  let cached: string | null = null;
  try { cached = localStorage.getItem(key); } catch { /* storage unavailable */ }
  if (cached && textHash(cleanLines(cached)) === level.lyrics.hash) return chartWithLyrics(level, cached);
  const lrc = await fetchLrc(level.lyrics.lrclib);
  try { localStorage.setItem(key, lrc); } catch { /* full or unavailable */ }
  return chartWithLyrics(level, lrc);
}

export async function loadLevel(id: string): Promise<Level> {
  const r = await fetch(`levels/${id}/level.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`could not load level ${id}`);
  return r.json();
}

/** Levels whose audio files exist locally (written by scripts/levels.ts; not part of the release). */
export async function loadLocalIds(): Promise<Set<string>> {
  try {
    const r = await fetch("levels/local.json", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return new Set();
    return new Set((await r.json()).levels);
  } catch { return new Set(); }
}
