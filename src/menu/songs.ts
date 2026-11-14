// Shared data for the song menu (used by the menu mockups): every level as a Song, with its difficulty,
// cover, best score and where its audio comes from, plus starting a song.
import { difficulty, flatten, loadLevelIds, type Chart } from "../chart";
import { loadLevel, loadLocalIds, loadLyrics, skeleton, type Level } from "../lyrics";
import { tier } from "../dom";
import { go, type Screen } from "../main";
import { getBest, settings, saveSettings, type Best } from "../settings";
import { messageScreen, playScreen, type AudioSource } from "../play";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
export const TIERS = ["Easy", "Normal", "Hard", "Expert", "Insane"] as const;
export type TierName = (typeof TIERS)[number];

export interface Song {
  id: string;
  title: string;
  artist: string;
  duration: number; // seconds at 1x
  lines: number; // typeable lines
  level: Level;
  chart: Chart; // skeleton (placeholder text): enough for difficulty
  art?: string; // album art (iTunes), when found
  thumb?: string; // YouTube thumbnail (16:9), fallback when there's no art
  local: boolean; // has local audio files (dev)
  youtube: boolean;
}

/** All songs, in the order of the level index (alphabetical by id). */
export async function loadSongs(): Promise<Song[]> {
  const [ids, local] = await Promise.all([loadLevelIds(), loadLocalIds()]);
  const levels = await Promise.all(ids.map(loadLevel));
  return levels.map((level) => {
    const chart = skeleton(level);
    return {
      id: level.id, title: level.title, artist: level.artist, duration: level.duration,
      lines: flatten(chart).lines.length, level, chart, art: level.art,
      thumb: level.youtube ? `https://i.ytimg.com/vi/${level.youtube.id}/mqdefault.jpg` : undefined,
      local: local.has(level.id), youtube: !!level.youtube,
    };
  });
}

export interface Difficulty { needs: number; burst: number; tier: TierName; cls: string }
const cache = new Map<string, Difficulty>();
/** WPM the song needs at a speed (~p90 of its lines), its hardest line, and the tier name/class. */
export function difficultyOf(song: Song, speed: number): Difficulty {
  const k = `${song.id}@${speed}`;
  let d = cache.get(k);
  if (!d) {
    const { needs, burst } = difficulty(song.chart, speed);
    const t = tier(needs);
    d = { needs, burst, tier: t.name as TierName, cls: t.cls };
    cache.set(k, d);
  }
  return d;
}

export function bestOf(song: Song, speed: number): Best | undefined { return getBest(song.id, speed); }

/** "3:14" at a speed. */
export function lengthAt(song: Song, speed: number): string {
  const s = Math.round(song.duration / speed);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Where the audio would come from (local files when present and preferred, else the YouTube video). */
export function sourceFor(song: Song): AudioSource | null {
  if (song.local && song.youtube) return settings.audioSource;
  return song.local ? "local" : song.youtube ? "youtube" : null;
}

/** Play a song at a speed (remembers both as the current selection). */
export function startSong(song: Song, speed: number): void {
  const source = sourceFor(song);
  if (!source) return;
  settings.levelId = song.id;
  settings.speed = speed;
  saveSettings();
  go(async (): Promise<Screen> => {
    let chart: Chart;
    try { chart = await loadLyrics(song.level); } catch (err) {
      return messageScreen("Couldn't load the lyrics", err instanceof Error ? err.message : String(err));
    }
    return playScreen(chart, speed, source);
  });
}

/** Normalised text for search ("Can't" matches "cant"). */
export function searchKey(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "");
}
export function matches(song: Song, query: string): boolean {
  const q = searchKey(query).trim();
  if (!q) return true;
  const hay = searchKey(`${song.title} ${song.artist}`);
  return q.split(/\s+/).every((w) => hay.includes(w));
}
