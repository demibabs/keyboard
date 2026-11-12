// Per-browser settings and best scores (localStorage, guarded).
export interface Settings {
  audioOffsetMs: number; // added to key times' lag: key judged at (heard time - audioOffset)
  visualOffsetMs: number; // display/input lag measured by the visual test
  volume: number;
  speed: number;
  levelId: string;
}
export interface Best { score: number; grade: string; accuracy: number; fc: boolean }

const KEY = "lyric-typer:settings";
const BEST = "lyric-typer:best-v2"; // v2: accuracy + line-bonus scoring (old timing-based bests aren't comparable)
const defaults: Settings = { audioOffsetMs: 0, visualOffsetMs: 0, volume: 0.8, speed: 0.75, levelId: "" };

function read<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
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
