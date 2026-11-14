// Per-browser settings and best scores (localStorage, guarded).
export interface Settings {
  audioOffsetMs: number; // added to key times' lag: key judged at (heard time - audioOffset)
  visualOffsetMs: number; // display/input lag measured by the visual test
  volume: number;
  speed: number;
  levelId: string;
  audioSource: "local" | "youtube"; // preferred, when a level has both
}
export interface Best { score: number; grade: string; accuracy: number; fc: boolean }

const KEY = "startype:settings";
const BEST = "startype:best-v2"; // v2: accuracy + line-bonus scoring (old timing-based bests aren't comparable)
// names used before the renames (Lyric Typer, then Keyboard), newest first
const OLD_NAMES: Record<string, string[]> = {
  [KEY]: ["keyboard:settings", "lyric-typer:settings"],
  [BEST]: ["keyboard:best-v2", "lyric-typer:best-v2"],
};
const defaults: Settings = { audioOffsetMs: 0, visualOffsetMs: 0, volume: 0.8, speed: 0.75, levelId: "", audioSource: "local" };

function read<T>(k: string, fallback: T): T {
  try {
    let v = localStorage.getItem(k);
    for (const old of OLD_NAMES[k] ?? []) v ??= localStorage.getItem(old);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch { return fallback; }
}
function write(k: string, v: unknown): void {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

export const settings: Settings = read(KEY, defaults);
export function saveSettings(): void { write(KEY, settings); }

type BestTable = Record<string, Best>;
const bests: BestTable = read<BestTable>(BEST, {});
const bestKey = (id: string, speed: number) => `${id}@${speed.toFixed(2)}`;
export function getBest(id: string, speed: number): Best | undefined { return bests[bestKey(id, speed)]; }
/** Records a result; returns true if it's a new best. */
export function recordBest(id: string, speed: number, b: Best): boolean {
  const k = bestKey(id, speed);
  if (bests[k] && bests[k].score >= b.score) return false;
  bests[k] = b;
  write(BEST, bests);
  return true;
}
