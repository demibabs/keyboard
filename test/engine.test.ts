import { describe, expect, it } from "vitest";
import { Engine, OPEN_EARLY, POINTS, FIXED_WEIGHT, REACTION } from "../src/engine";
import { flatten, type Chart } from "../src/chart";

// "Hello world!" at 1.0 (open until 4.0), "black-and (yeah) white" at 4.0 (until the blank line at 6.0),
// an ad-lib line that's all parentheses at 7.0, and "last" at 8.0 (until the song ends at 10).
const chart: Chart = {
  format: 2, id: "t", version: 1, title: "t", artist: "a", duration: 10, offsetMs: 0, speeds: [1], audio: "",
  lines: [
    { t: 1, text: "Hello world!" },
    { t: 4, text: "black-and (yeah) white" },
    { t: 6, text: "" },
    { t: 7, text: "(ooh)" },
    { t: 8, text: "last" },
  ],
};

function typeAll(e: Engine, s: string, t: number, step = 0.01) {
  for (const ch of s) { e.key(ch, t); t += step; }
  return t;
}
const states = (e: Engine, a = 0, b = 11) => e.charState.slice(a, b).join(",");

describe("chart", () => {
  it("flattens lines, skips parentheses and blank/ad-lib lines, joins hyphens", () => {
    const f = flatten(chart);
    expect(f.lines.map((l) => l.text)).toEqual(["Hello world!", "black-and (yeah) white", "last"]);
    expect(f.chars.map((c) => c.ch).join("")).toBe("hello worldblack and whitelast");
    expect(f.chars[16].hyphen).toBe(true);
    expect(f.lines.map((l) => l.next)).toEqual([4, 6, 10]);
    const l1 = f.lines[1];
    expect(l1.map.slice(10, 16).every((x) => x === -1)).toBe(true);
    expect(l1.paren[11]).toBe(true);
  });
});

describe("engine", () => {
  it("a clean, quick line scores letters + line bonus (x accuracy x speed) + clean bonus", () => {
    const e = new Engine(chart, 1);
    typeAll(e, "hello world", 1.0, 0.01); // 10 letters, finished at ~1.1 of a 3 s line
    const r = e.lineResult[0]!;
    expect(r.done && r.clean).toBe(true);
    expect(r.accuracy).toBe(1);
    expect(r.speed).toBeCloseTo(1 - 0.1 / 3, 2);
    const expected = 10 * POINTS.letter + 10 * (POINTS.lineBonus * (1 + r.speed) + POINTS.cleanBonus);
    expect(e.score).toBeCloseTo(expected, 5);
  });

  it("finishing slower earns a smaller bonus", () => {
    const fast = new Engine(chart, 1); typeAll(fast, "hello world", 1.0, 0.01);
    const slow = new Engine(chart, 1); typeAll(slow, "hello world", 1.0, 0.25);
    expect(slow.lineResult[0]!.done).toBe(true);
    expect(slow.lineResult[0]!.speed).toBeLessThan(fast.lineResult[0]!.speed);
    expect(slow.score).toBeLessThan(fast.score);
  });

  it("a mistake removes the clean bonus and scales the line bonus by accuracy", () => {
    const e = new Engine(chart, 1);
    typeAll(e, "hxllo world", 1.0, 0.01);
    const r = e.lineResult[0]!;
    expect(r.clean).toBe(false);
    expect(r.accuracy).toBeCloseTo(0.9);
    expect(e.score).toBeCloseTo(9 * POINTS.letter + 10 * POINTS.lineBonus * 0.9 * (1 + r.speed), 5);
  });

  it("keys before a line opens are ignored without penalty", () => {
    const e = new Engine(chart, 1);
    e.key("h", 1 - OPEN_EARLY - 0.01);
    expect(e.pos).toBe(0);
    expect(e.score).toBe(0);
    expect(e.events.some((v) => v.type === "early")).toBe(true);
    e.key("h", 1 - OPEN_EARLY + 0.01); // a little early is fine
    expect(e.pos).toBe(1);
  });

  it("a line stays open until the next line starts, then the rest drops (no line bonus)", () => {
    const e = new Engine(chart, 1);
    typeAll(e, "hel", 1.0);
    e.key("l", 3.99);
    expect(e.charState[3]).toBe("ok");
    e.update(4.0);
    expect(e.pos).toBe(11);
    expect(e.counts.drop).toBe(6);
    expect(e.lineResult[0]!.done).toBe(false);
    expect(e.score).toBeCloseTo(4 * POINTS.letter);
  });

  it("a blank line closes the line before it; an ad-lib line doesn't", () => {
    const e = new Engine(chart, 1);
    expect(e.deadline(1)).toBeCloseTo(6);
    expect(e.deadline(2)).toBeCloseTo(10);
  });

  it("skipping a whole line lands on the next one", () => {
    const e = new Engine(chart, 1);
    e.key("b", 4.0);
    expect(e.lineResult[0]!.done).toBe(false);
    expect(e.pos).toBe(12);
  });

  it("every wrong key marks the letter and advances", () => {
    const e = new Engine(chart, 1);
    e.key("h", 1); e.key("x", 1.05); e.key("q", 1.06);
    expect(states(e, 0, 3)).toBe("ok,typo,typo");
    expect(e.pos).toBe(3);
  });

  it("forgotten space: counts the space and applies the key to the next word", () => {
    const e = new Engine(chart, 1);
    typeAll(e, "hellow", 1);
    expect(e.counts.spaceMiss).toBe(1);
    expect(e.charState[6]).toBe("ok");
  });

  it("hyphen or space both work between joined words", () => {
    for (const sep of [" ", "-"]) {
      const e = new Engine(chart, 1);
      e.update(4.0);
      typeAll(e, `black${sep}and white`, 4.0);
      expect(e.counts.spaceMiss + e.counts.typo).toBe(0);
      expect(e.lineResult[1]!.clean).toBe(true);
    }
  });

  it("reaction time: wrong keys right after a line pops up are ignored, right ones count", () => {
    const e = new Engine(chart, 1);
    typeAll(e, "hello wor", 1.0, 0.05); // line 0 not finished when it closes at 4.0
    e.update(4.0);
    e.key("l", 4.1); // still finishing "world": ignored
    e.key("d", 4.15);
    expect(e.pos).toBe(11);
    expect(e.counts.typo).toBe(0);
    e.key("b", 4.2); // right key: counts
    e.key("x", 4.25); // wrong, still within the reaction time: ignored even after a right key
    expect(e.pos).toBe(12);
    expect(e.counts.typo).toBe(0);
    e.key("q", 4.0 + REACTION + 0.01); // after it: a normal typo
    expect(e.counts.typo).toBe(1);
  });

  it("no reaction window when moving on to the next line on purpose", () => {
    const e = new Engine(chart, 1);
    typeAll(e, "hello wor", 1.0, 0.05);
    e.key("b", 3.9); // next line is open (3.7): catch-up
    e.key("x", 3.95);
    expect(e.counts.typo).toBe(1);
  });

  it("scales times and score by speed", () => {
    const e = new Engine(chart, 0.5);
    expect(e.onset(0)).toBeCloseTo(2);
    expect(e.deadline(0)).toBeCloseTo(8);
    e.key("h", 2.0);
    expect(e.score).toBeCloseTo(POINTS.letter * 0.5);
  });

  describe("autocorrection", () => {
    it("skipped letter: realigns; those letters count as autocorrected (75%)", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "hllo world", 1.0, 0.1);
      expect(e.pos).toBe(11);
      expect(states(e)).toBe("ok,typo,fixed,fixed,fixed,ok,ok,ok,ok,ok,ok");
      expect(e.counts.fixed).toBe(3);
      expect(e.lineResult[0]!.accuracy).toBeCloseTo((6 + 3 * FIXED_WEIGHT) / 10);
      expect(e.lineResult[0]!.clean).toBe(false);
    });

    it("extra letter: realigns; one missed key, re-scored letters are autocorrected", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "heello world", 1.0, 0.1);
      expect(e.pos).toBe(11);
      expect(e.counts.typo).toBe(1);
      expect(states(e)).toBe("ok,fixed,fixed,fixed,ok,ok,ok,ok,ok,ok,ok");
    });

    it("a single wrong letter doesn't trigger it", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "hxllo world", 1.0, 0.1);
      expect(e.events.some((ev) => ev.type === "resync")).toBe(false);
      expect(e.counts.fixed).toBe(0);
    });

    it("skipped word: jumps to the word being typed", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "world", 1.0, 0.1);
      expect(e.pos).toBe(11);
      expect(e.counts.typo).toBe(0);
      expect(e.counts.drop).toBe(5);
      expect(states(e)).toBe("drop,drop,drop,drop,drop,drop,fixed,fixed,fixed,ok,ok");
    });

    it("abandoned word close by: a small forward shift (skipped letters count as missed)", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "helworld", 1.0, 0.1);
      expect(e.pos).toBe(11);
      expect(states(e)).toBe("ok,ok,ok,typo,typo,typo,fixed,fixed,fixed,ok,ok");
    });

    it("abandoned word far back: a word skip", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "hworld", 1.0, 0.1);
      expect(e.pos).toBe(11);
      expect(states(e)).toBe("ok,drop,drop,drop,drop,drop,fixed,fixed,fixed,ok,ok");
    });

    it("a few extra keys: moves the cursor back (each extra key is one miss)", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "helqqlo world", 1.0, 0.05);
      expect(e.pos).toBe(11);
      expect(e.counts.typo).toBe(2);
      expect(states(e)).toBe("ok,ok,ok,fixed,fixed,fixed,ok,ok,ok,ok,ok");
    });

    it("never moves back over a whole word", () => {
      const e = new Engine({ ...chart, lines: [{ t: 1, text: "we go we go now" }] }, 1);
      typeAll(e, "we go we we go now", 1.0, 0.05); // repeated "we " (3 back, a whole word)
      expect(e.events.some((ev) => ev.type === "resync" && ev.shift <= -2)).toBe(false);
    });

    it("a doubled one-letter word is still fixed by a one-key move back", () => {
      const e = new Engine({ ...chart, lines: [{ t: 1, text: "did I dream" }] }, 1);
      typeAll(e, "did ii dream", 1.0, 0.05);
      expect(e.pos).toBe(11);
      expect(e.counts.typo).toBe(1);
    });

    it("prefers a small forward shift to a word skip when accuracy ties", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "hello orld", 1.0, 0.05);
      expect(e.events.some((ev) => ev.type === "resync" && ev.shift === 1)).toBe(true);
    });

    it("score stays consistent after re-scoring (letters + bonus add up)", () => {
      const e = new Engine(chart, 1);
      typeAll(e, "hllo world", 1.0, 0.1);
      const r = e.lineResult[0]!;
      const letters = (6 + 3 * FIXED_WEIGHT) * POINTS.letter;
      expect(e.score).toBeCloseTo(letters + 10 * POINTS.lineBonus * r.accuracy * (1 + r.speed), 5);
    });
  });
});

describe("typed text", () => {
  it("splits ligatures and maps lookalike Cyrillic letters to Latin", async () => {
    const { typedOf } = await import("../src/chart");
    expect(typedOf("ﬁnd")).toBe("find");
    expect(typedOf("lovе")).toBe("love"); // Cyrillic е
    expect(typedOf("Jéja")).toBe("jeja");
    const f = flatten({ ...chart, lines: [{ t: 1, text: "ﬁne day" }] });
    expect(f.chars.map((c) => c.ch).join("")).toBe("fine day");
  });
});
