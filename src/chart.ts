// Chart format (public/levels/<id>/chart.json) and helpers to turn it into a typeable character stream.
// Lines are timed by their start only (LRC-style). A line can be typed until the next line starts.

export interface ChartLine {
  t: number; // start (chart seconds at 1.0x)
  text: string; // display text; parenthesised parts are shown but not typed
}
export interface Chart {
  format: 2;
  id: string;
  version: number;
  title: string;
  artist: string;
  duration: number;
  offsetMs: number;
  speeds: number[];
  audio: string; // e.g. "audio@{speed}.ogg"
  lines: ChartLine[];
  source?: string; // where the timing came from
  youtube?: { id: string; offsetMs: number; duration?: number };
  note?: string; // shown on the play screen (e.g. timing may be off)
  art?: string; // album art URL
}

/** The characters a player types for a piece of display text: lowercase letters and digits only. */
// Cyrillic/Greek letters that look identical to Latin ones (they slip into lyric sites as typos)
const LOOKALIKE: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ԛ: "q", ԝ: "w",
  к: "k", м: "m", т: "t", в: "b", н: "h", ο: "o", α: "a", ε: "e", ι: "i", κ: "k", ν: "v", ρ: "p", τ: "t", υ: "u",
};

export function typedOf(d: string): string {
  // NFKD also splits ligatures ("ﬁ" -> "fi") and full-width letters; then accents go, lookalikes map to Latin
  return d.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/./gu, (c) => LOOKALIKE[c] ?? c).replace(/[^a-z0-9]/g, "");
}

export interface Char {
  ch: string; // expected key
  kind: "letter" | "space";
  hyphen: boolean; // a space that stands for a hyphen (accepts "-" too)
  line: number; // index into Flat.lines
}

/** A typeable line. Chars [first, end) belong to it. */
export interface FlatLine {
  index: number; // position in Flat.lines
  chartIndex: number; // position in chart.lines
  text: string;
  t: number; // start, chart time
  next: number; // when the next typeable line starts (or the song ends), chart time
  first: number;
  end: number;
  /** per display character: index of the char it types, or -1 */
  map: number[];
  /** per display character: inside parentheses (shown, not typed) */
  paren: boolean[];
}

export interface Flat { chars: Char[]; lines: FlatLine[] }

const WORD = /[\p{L}\p{N}'’]+/gu;

export function flatten(chart: Chart): Flat {
  const chars: Char[] = [];
  const lines: FlatLine[] = [];
  chart.lines.forEach((cl, ci) => {
    const text = cl.text;
    const paren = parenMask(text);
    const map: number[] = new Array(text.length).fill(-1);
    const words = [...text.matchAll(WORD)].filter((m) => !paren[m.index!] && typedOf(m[0]));
    if (!words.length) return;
    const li = lines.length;
    const first = chars.length;
    words.forEach((m, wi) => {
      const start = m.index!;
      if (wi > 0) {
        const prev = words[wi - 1];
        const prevEnd = prev.index! + prev[0].length;
        const gap = text.slice(prevEnd, start);
        const hyphen = gap.includes("-") && !/\s/.test(gap);
        let at = prevEnd + Math.max(0, gap.search(hyphen ? /-/ : /\s/));
        if (at >= start) at = -1;
        if (at >= 0) map[at] = chars.length;
        chars.push({ ch: " ", kind: "space", hyphen, line: li });
      }
      for (let k = 0; k < m[0].length; k++) {
        const t = typedOf(m[0][k]);
        if (!t) continue;
        map[start + k] = chars.length; // a ligature like "ﬁ" types as several letters
        for (const ch of t) chars.push({ ch, kind: "letter", hyphen: false, line: li });
      }
    });
    lines.push({ index: li, chartIndex: ci, text, t: cl.t, next: 0, first, end: chars.length, map, paren });
  });
  // A line is open until the next line starts. Blank chart lines (end-of-vocals markers) count as a next
  // line; lines that are all parentheses (ad-libs) don't.
  for (const l of lines) {
    const after = chart.lines.slice(l.chartIndex + 1).find((cl) => !cl.text.trim() || isTypeable(cl.text));
    l.next = after ? after.t : chart.duration > l.t + 1 ? chart.duration : l.t + 4;
  }
  return { chars, lines };
}

function isTypeable(text: string): boolean {
  const paren = parenMask(text);
  return [...text.matchAll(WORD)].some((m) => !paren[m.index!] && typedOf(m[0]));
}

/** true for characters inside (...) or [...] */
function parenMask(text: string): boolean[] {
  const out: boolean[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    out.push(depth > 0);
    if ((c === ")" || c === "]") && depth > 0) depth--;
  }
  return out;
}

export async function loadLevelIds(): Promise<string[]> {
  const r = await fetch("levels/index.json", { cache: "no-store" });
  return (await r.json()).levels;
}

export function audioUrl(chart: Chart, speed: number): string {
  return `levels/${chart.id}/` + chart.audio.replace("{speed}", speed.toFixed(2));
}

/** Difficulty at a speed: chars per second each line needs (its start -> the next line's start), as WPM.
 * `needs` blends the 90th-percentile line with the overall rate; `burst` is the hardest line. */
export function difficulty(chart: Chart, speed: number): { needs: number; burst: number } {
  const { lines } = flatten(chart);
  const rates: number[] = [];
  let n = 0, w = 0;
  for (const l of lines) {
    const count = l.end - l.first;
    const win = Math.max(0.3, (l.next - l.t) / speed);
    rates.push(count / win);
    n += count; w += win;
  }
  if (!rates.length) return { needs: 0, burst: 0 };
  const sorted = [...rates].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.round(0.9 * (sorted.length - 1)))];
  return { needs: Math.round(12 * (0.5 * p90 + 0.5 * (n / w))), burst: Math.round(12 * sorted[sorted.length - 1]) };
}
