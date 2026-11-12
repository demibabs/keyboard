// Judging engine: no DOM, no audio. Times passed in are "real" song seconds at the chosen speed,
// already corrected for latency (see audio.ts / settings). Chart times are divided by speed.
//
// A line opens slightly before its timestamp and stays open until the next line starts. Scoring is about
// accuracy: raw-correct letters score fully, letters fixed by autocorrection score 75%, and finishing a
// line earns a bonus scaled by its accuracy and by how quickly it was finished, plus extra for a clean line.
// Wrong keys mark the letter missed and advance. Autocorrection: one-letter shift resync, and word skip.
import { flatten, type Chart, type Flat, type FlatLine } from "./chart";

/** a line accepts keys this long (real seconds) before its timestamp (LRC timing is often a bit off) */
export const OPEN_EARLY = 0.3;
/** wrong keys are ignored for this long (real seconds) after a new line becomes current, so finishing the
 * previous line's words as the next one pops up doesn't count against the new line */
export const REACTION = 0.5;
export type CharState = "pending" | "ok" | "fixed" | "typo" | "drop";
export const FIXED_WEIGHT = 0.75;
export const POINTS = { letter: 10, lineBonus: 5, cleanBonus: 5 } as const; // per letter
const RESYNC_KEYS = 3; // keys in a row that must fit a new alignment before autocorrect moves the cursor
const MAX_FWD = 3; // small forward shift (skipped letters)
const MAX_BACK = 4; // backward shift (extra keys), never back over a whole word

interface KeyLog { ch: string; pos: number; line: number; typo: boolean; score: number }

export interface LineResult {
  done: boolean; // typed through to the end before it closed
  accuracy: number; // weighted letter accuracy of the line
  clean: boolean; // no mistakes at all (no typos, autocorrections or missed spaces)
  speed: number; // 0 (finished as the line closed) .. 1 (instantly)
  bonus: number;
}

export type EngineEvent =
  | { type: "typo"; char: number }
  | { type: "resync"; line: number; shift: number; pos: number }
  | { type: "early"; line: number }
  | { type: "ignored"; line: number }
  | { type: "drop"; line: number; count: number }
  | { type: "line"; line: number; result: LineResult };

export interface Counts { ok: number; fixed: number; typo: number; drop: number; spaceMiss: number; lines: number; clean: number }

export class Engine {
  readonly flat: Flat;
  readonly lines: FlatLine[];
  readonly speed: number;
  readonly offset: number; // chart offset in seconds
  pos = 0;
  score = 0;
  okChars = 0;
  readonly totalLetters: number;
  readonly charState: CharState[];
  readonly lineResult: (LineResult | null)[];
  readonly counts: Counts = { ok: 0, fixed: 0, typo: 0, drop: 0, spaceMiss: 0, lines: 0, clean: 0 };
  events: EngineEvent[] = [];
  private log: KeyLog[] = [];
  private enteredAt = -Infinity; // when the cursor's line became current (for the reaction window)
  private flawed: boolean[]; // per line: any mistake so far

  constructor(chart: Chart, speed: number) {
    this.flat = flatten(chart);
    this.lines = this.flat.lines;
    this.speed = speed;
    this.offset = (chart.offsetMs || 0) / 1000;
    this.charState = this.flat.chars.map(() => "pending");
    this.totalLetters = this.flat.chars.filter((c) => c.kind === "letter").length;
    this.lineResult = this.lines.map(() => null);
    this.flawed = this.lines.map(() => false);
  }

  /** chart seconds -> real seconds at this speed */
  real(t: number): number { return (t + this.offset) / this.speed; }
  /** line timestamp (real seconds) */
  onset(i: number): number { return this.real(this.lines[i].t); }
  /** when line i starts accepting keys */
  opens(i: number): number { return this.onset(i) - OPEN_EARLY; }
  /** when line i closes: the next line's start (real seconds) */
  deadline(i: number): number { return this.real(this.lines[i].next); }
  get finished(): boolean { return this.pos >= this.flat.chars.length; }
  get allClean(): boolean { return this.counts.clean === this.lines.length; }
  /** line the cursor is in, or -1 at the end */
  get cursorLine(): number { return this.pos < this.flat.chars.length ? this.flat.chars[this.pos].line : -1; }

  /** Advance time: drop whatever the player didn't finish before each line closed. */
  update(now: number): void {
    while (this.pos < this.flat.chars.length) {
      const li = this.flat.chars[this.pos].line;
      if (now < this.deadline(li)) break;
      this.dropRest(li);
      this.enteredAt = this.deadline(li); // the next line popped up when this one closed
    }
  }

  key(ch: string, now: number): void {
    this.update(now);
    const { chars } = this.flat;
    if (this.pos >= chars.length) return;
    const c = chars[this.pos];
    const l = this.lines[c.line];
    if (this.log.length && this.log[this.log.length - 1].line !== l.index) this.log = [];

    if (this.pos === l.first && now < this.opens(l.index)) {
      this.events.push({ type: "early", line: l.index }); // not open yet: ignored, no penalty
      return;
    }
    if (!this.fits(this.pos, ch) && now < this.enteredAt + REACTION) {
      this.events.push({ type: "ignored", line: l.index }); // reaction time: wrong keys don't count yet
      return;
    }

    if (this.fits(this.pos, ch)) {
      const before = this.score;
      this.mark(this.pos, "ok");
      this.log.push({ ch, pos: this.pos, line: l.index, typo: false, score: this.score - before });
      this.advance(now);
      return;
    }

    // Forgot the space between words: count the space as missed and use the key for the next word.
    // Only when the recent keys were right and this one isn't a repeat; otherwise the player may be
    // shifted, which realign handles.
    const inSync = !this.log.slice(-RESYNC_KEYS).some((e) => e.typo);
    const doubled = chars[this.pos - 1]?.ch === ch; // "doess she": the extra letter, not a missing space
    if (c.kind === "space" && inSync && !doubled && chars[this.pos + 1]?.ch === ch) {
      this.charState[this.pos] = "typo";
      this.counts.spaceMiss++;
      this.flawed[l.index] = true;
      this.pos++;
      this.key(ch, now);
      return;
    }
    // Catch-up: the player moved on to a later line that's open. Drop what's left before it.
    for (let j = l.index + 1; j < this.lines.length && this.opens(j) <= now; j++) {
      if (chars[this.lines[j].first].ch !== ch) continue;
      while (this.pos < this.lines[j].first) this.dropRest(chars[this.pos].line);
      this.enteredAt = -Infinity; // moved on deliberately: no reaction window
      this.key(ch, now);
      return;
    }
    const before = this.score;
    this.mark(this.pos, "typo");
    this.log.push({ ch, pos: this.pos, line: l.index, typo: true, score: this.score - before });
    this.events.push({ type: "typo", char: this.pos });
    this.pos++;
    this.realign();
    this.checkDone(l.index, now);
    if (this.cursorLine !== l.index) this.enteredAt = now;
  }

  /** weighted letter accuracy: raw 1, autocorrected 0.75, missed 0 (so far, or over the whole song) */
  accuracy(final = false): number {
    const got = this.counts.ok + FIXED_WEIGHT * this.counts.fixed;
    let done = this.totalLetters;
    if (!final) {
      done = 0;
      for (let i = 0; i < this.pos; i++) if (this.flat.chars[i].kind === "letter") done++;
    }
    return done ? got / done : 1;
  }

  /** Typed WPM over the time lines were open. */
  wpm(): number {
    const secs = this.lines.reduce((s, l) => s + this.deadline(l.index) - this.onset(l.index), 0);
    return secs > 0 ? (this.okChars / 5) / (secs / 60) : 0;
  }

  private advance(now: number): void {
    const li = this.flat.chars[this.pos].line;
    this.pos++;
    this.checkDone(li, now);
    if (this.cursorLine !== li) this.enteredAt = now;
  }

  /** the cursor just left line li by typing: score the line */
  private checkDone(li: number, now: number): void {
    const l = this.lines[li];
    if (this.pos < l.end || this.lineResult[li]) return;
    let got = 0, n = 0;
    for (let p = l.first; p < l.end; p++) {
      if (this.flat.chars[p].kind !== "letter") continue;
      n++;
      const s = this.charState[p];
      if (s === "ok") got += 1;
      else if (s === "fixed") got += FIXED_WEIGHT;
    }
    const accuracy = n ? got / n : 1;
    const span = Math.max(0.01, this.deadline(li) - this.onset(li));
    const speed = Math.max(0, Math.min(1, 1 - (now - this.onset(li)) / span));
    const clean = !this.flawed[li] && accuracy === 1;
    const bonus = n * this.speed * (POINTS.lineBonus * accuracy * (1 + speed) + (clean ? POINTS.cleanBonus : 0));
    this.score += bonus;
    this.counts.lines++;
    if (clean) this.counts.clean++;
    const result: LineResult = { done: true, accuracy, clean, speed, bonus };
    this.lineResult[li] = result;
    this.log = [];
    this.events.push({ type: "line", line: li, result });
  }

  /**
   * Autocorrection, run after each typo. Looks for an alignment that explains the player's recent keys
   * (RESYNC_KEYS or more in a row that fit it, at least two of them currently typos):
   *  - small forward shift (1..MAX_FWD letters): letters were skipped; they count as missed
   *  - backward shift (1..MAX_BACK, never back over a word already typed right): extra keys; each is a miss
   *  - word skip: the player jumped to the start of a later word in the line; skipped letters drop
   * Among the alignments that fit, it takes the one giving the line the best final accuracy (assuming the
   * player types the rest correctly from there). Ties prefer small forward moves, then backward, then word
   * skips, then the smaller move.
   * Keys it moves count as autocorrected letters (75%).
   */
  private realign(): boolean {
    const { chars } = this.flat;
    const L = this.log;
    const last = L[L.length - 1];
    if (!last) return false;
    const line = this.lines[last.line];
    let s = L.length; // start of the contiguous run of logged keys in this line
    while (s > 0 && L[s - 1].line === last.line && L[s - 1].pos === last.pos - (L.length - s)) s--;
    const inLine = (p: number) => p >= line.first && p < line.end;
    const typos = (from: number) => L.slice(from).filter((e) => e.typo).length;

    // Final accuracy of the line if keys L[start..] land at target.. (the `extras` keys before them being
    // extra keystrokes, each a miss) and the player types the rest of the line correctly from there.
    // Letters skipped over count as missed.
    const accuracyIf = (start: number, target: number, extras: number): number => {
      const st = this.charState.slice(line.first, line.end);
      const at = (p: number) => p - line.first;
      for (let k = start - extras; k < L.length; k++) st[at(L[k].pos)] = "pending";
      const n = L.length - start;
      for (let k = 0; k < n; k++) st[at(target + k)] = "fixed";
      for (let p = L[start - extras].pos; p < target; p++) if (st[at(p)] === "pending") st[at(p)] = "typo";
      let got = 0, letters = extras;
      for (let p = line.first; p < line.end; p++) {
        if (chars[p].kind !== "letter") continue;
        letters++;
        const x = st[at(p)];
        got += x === "ok" ? 1 : x === "fixed" ? FIXED_WEIGHT : x === "pending" && p >= target + n ? 1 : 0;
      }
      return letters ? got / letters : 1;
    };

    type Cand = { kind: 0 | 1 | 2; move: number; start: number; target: number; extras: number; acc: number };
    const cands: Cand[] = [];
    // shifts: keys land `d` positions away from where they were applied
    for (const d of [1, 2, 3, -1, -2, -3, -4]) {
      if (d > MAX_FWD || -d > MAX_BACK) continue;
      let start = L.length;
      while (start > s && inLine(L[start - 1].pos + d) && this.fits(L[start - 1].pos + d, L[start - 1].ch)) start--;
      if (L.length - start < RESYNC_KEYS || typos(start) < 2) continue;
      const target = L[start].pos + d;
      const extras = d < 0 ? -d : 0;
      if (extras && start - extras < s) continue; // the extra keys must be in this run of keys too
      // several extra keystrokes are only believable if at least one of them was a wrong key ("its s|s"
      // after skipping a letter must not read as two extra correct keys); one extra key may be a doubled letter
      if (extras > 1 && !L.slice(start - extras, start).some((e) => e.typo)) continue;
      // never back over a whole word already typed right (that's repeating a finished word, not a slip);
      // a one-key move is just a doubled letter, even on a word like "I"
      if (extras > 1 && this.typedWordInside(line, target, L[start].pos)) continue;
      cands.push({ kind: d > 0 ? 0 : 1, move: Math.abs(d), start, target, extras, acc: accuracyIf(start, target, extras) });
    }
    // word skips: the recent keys spell the start of a later word
    for (let start = s; start <= L.length - RESYNC_KEYS; start++) {
      if (typos(start) < 2) continue;
      const n = L.length - start;
      for (let w = L[start].pos + 1; w + n <= line.end; w++) {
        if (chars[w].kind !== "letter" || (w !== line.first && chars[w - 1].kind !== "space")) continue;
        if (!L.slice(start).every((e, k) => this.fits(w + k, e.ch))) continue;
        cands.push({ kind: 2, move: w - L[start].pos, start, target: w, extras: 0, acc: accuracyIf(start, w, 0) });
      }
    }
    // accuracies within a hair of each other count as equal, so the preference order decides
    const best = cands.sort((a, b) => (Math.abs(b.acc - a.acc) > 1e-9 ? b.acc - a.acc : 0) || a.kind - b.kind || a.move - b.move)[0];
    if (!best) return false;

    const run = L.slice(best.start);
    const extras = L.slice(best.start - best.extras, best.start);
    for (const e of [...extras, ...run]) this.unapply(e);
    let dropped = 0;
    for (let p = (extras[0] ?? run[0]).pos; p < best.target; p++) {
      if (this.charState[p] !== "pending") continue;
      if (best.kind === 2) {
        this.charState[p] = "drop";
        if (chars[p].kind === "letter") dropped++;
      } else this.mark(p, "typo"); // skipped by a small forward shift: missed
    }
    this.counts.drop += dropped;
    run.forEach((_, k) => this.mark(best.target + k, "fixed"));
    this.counts.typo += best.extras; // the extra keystrokes
    this.pos = best.target + run.length;
    this.flawed[line.index] = true;
    this.log = [];
    // how far the cursor moved relative to where the moved keys had been applied (negative = back)
    this.events.push({ type: "resync", line: line.index, shift: best.target - run[0].pos, pos: this.pos });
    return true;
  }

  /** whether a whole word that was typed right (every letter ok) lies inside [from, to) of a line */
  private typedWordInside(line: FlatLine, from: number, to: number): boolean {
    const { chars } = this.flat;
    for (let p = from; p < to; p++) {
      if (chars[p].kind !== "letter" || (p !== line.first && chars[p - 1].kind !== "space")) continue;
      let e = p;
      while (e < line.end && chars[e].kind === "letter") e++;
      if (e <= to && this.charState.slice(p, e).every((x) => x === "ok")) return true;
    }
    return false;
  }

  private fits(p: number, ch: string): boolean {
    const c = this.flat.chars[p];
    return !!c && (ch === c.ch || (c.kind === "space" && c.hyphen && ch === "-"));
  }
  /** set a char's state and score it (letters: raw 10, fixed 7.5, typo 0) */
  private mark(p: number, s: "ok" | "fixed" | "typo"): void {
    this.charState[p] = s;
    const letter = this.flat.chars[p].kind === "letter";
    if (s === "typo") {
      this.flawed[this.flat.chars[p].line] = true;
      if (letter) this.counts.typo++; else this.counts.spaceMiss++;
      return;
    }
    this.okChars++;
    if (!letter) return;
    this.counts[s]++;
    this.score += POINTS.letter * (s === "ok" ? 1 : FIXED_WEIGHT) * this.speed;
  }
  /** Undo a logged key's letter state and score. */
  private unapply(e: KeyLog): void {
    const letter = this.flat.chars[e.pos].kind === "letter";
    const s = this.charState[e.pos];
    this.charState[e.pos] = "pending";
    this.score -= e.score;
    if (s === "typo") { if (letter) this.counts.typo--; else this.counts.spaceMiss--; }
    else {
      this.okChars--;
      if (letter && (s === "ok" || s === "fixed")) this.counts[s]--;
    }
  }

  /** Mark the rest of line i as dropped and move the cursor past it. */
  private dropRest(i: number): void {
    const { chars } = this.flat;
    const l = this.lines[i];
    this.log = [];
    let dropped = 0;
    for (let p = this.pos; p < l.end; p++) {
      if (this.charState[p] !== "pending") continue;
      this.charState[p] = "drop";
      if (chars[p].kind === "letter") dropped++;
    }
    this.pos = Math.max(this.pos, l.end);
    if (dropped) {
      this.counts.drop += dropped;
      this.flawed[i] = true;
      this.events.push({ type: "drop", line: i, count: dropped });
    }
    if (!this.lineResult[i]) this.lineResult[i] = { done: false, accuracy: 0, clean: false, speed: 0, bonus: 0 };
  }
}

export function grade(accuracy: number): string {
  return accuracy >= 0.95 ? "S" : accuracy >= 0.9 ? "A" : accuracy >= 0.8 ? "B" : accuracy >= 0.7 ? "C" : "D";
}
