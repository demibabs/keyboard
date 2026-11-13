import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { chartWithLyrics, cleanLines, levelOf, parseLrc, skeleton, textHash } from "../src/lyrics";
import { difficulty, flatten, type Chart } from "../src/chart";

const LRC = [
  "[ar: Someone]", "[00:01.00]", "[00:02.50]Hello world!", "[00:05.00][00:20.00]Again (oh) again",
  "[00:08.00]", "[00:08.50]", "[00:09.00](ooh)", "[00:10.00]black-and white", "",
].join("\n");

describe("lrc", () => {
  it("parses stamps, repeats multi-stamp lines and sorts", () => {
    expect(parseLrc(LRC).map((l) => l.t)).toEqual([1, 2.5, 5, 8, 8.5, 9, 10, 20]);
  });
  it("drops leading blanks and collapses repeated blanks (like make_level.py)", () => {
    expect(cleanLines(LRC).map((l) => l.text)).toEqual(["Hello world!", "Again (oh) again", "", "(ooh)", "black-and white", "Again (oh) again"]);
  });
  it("hashes text only", () => {
    const a = cleanLines(LRC);
    expect(textHash(a)).toBe(textHash(a.map((l) => ({ ...l, t: l.t + 1 }))));
    expect(textHash(a)).not.toBe(textHash([...a.slice(0, -1), { t: 0, text: "Again (oh) agin" }]));
  });
});

describe("levels", () => {
  // a chart whose timing was retimed (+0.3 s) after it came from the LRC
  const chart: Chart = {
    format: 2, id: "t", version: 1, title: "t", artist: "a", duration: 30, offsetMs: 0, speeds: [1], audio: "",
    source: "lrclib:42+synccheck", lines: cleanLines(LRC).map((l) => ({ ...l, t: l.t + 0.3 })),
  };
  const level = levelOf(chart, { id: "vid", offsetMs: 0 });

  it("stores no text, only timing and typed-character counts", () => {
    expect(JSON.stringify(level)).not.toMatch(/hello|again|black/i);
    expect(level.lyrics).toEqual({ lrclib: 42, lines: 6, hash: textHash(chart.lines) });
    expect(level.lines.map((l) => l[1])).toEqual([11, 11, 0, -1, 15, 11]);
  });
  it("the skeleton gives the song list the same difficulty and line count", () => {
    for (const s of [0.5, 1, 1.5]) expect(difficulty(skeleton(level), s)).toEqual(difficulty(chart, s));
    expect(flatten(skeleton(level)).lines.length).toBe(flatten(chart).lines.length);
  });
  it("LRCLIB text + the level's timing rebuilds the chart", () => {
    const c = chartWithLyrics(level, LRC);
    expect(c.lines).toEqual(chart.lines);
    expect(c.note).toBeUndefined();
  });
  it("falls back to LRCLIB's timing (with a note) when its line count changed", () => {
    const c = chartWithLyrics(level, LRC + "[00:25.00]new line\n");
    expect(c.lines.length).toBe(7);
    expect(c.lines[0].t).toBe(2.5);
    expect(c.note).toBeTruthy();
  });
});

// Every committed level must still match a local full chart, when there is one.
it.skipIf(!fs.existsSync("public/levels/twilight-zone/chart.json"))("local charts and level.json agree", () => {
  for (const id of JSON.parse(fs.readFileSync("public/levels/index.json", "utf8")).levels) {
    const p = `public/levels/${id}/chart.json`;
    if (!fs.existsSync(p)) continue;
    const c: Chart = JSON.parse(fs.readFileSync(p, "utf8"));
    const l = JSON.parse(fs.readFileSync(`public/levels/${id}/level.json`, "utf8"));
    expect(l.lyrics.hash, id).toBe(textHash(c.lines));
    expect(l.lines.map((x: number[]) => x[0]), id).toEqual(c.lines.map((x) => x.t));
  }
});
