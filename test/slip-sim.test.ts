import { expect, it } from "vitest";
import fs from "node:fs";
import { Engine } from "../src/engine";

// For every line of the real chart and every position: type the line perfectly except for one slip
// (skipped letter, doubled letter, skipped word). The correction rules should keep the damage tiny.
// Needs a full local chart (lyric text isn't committed); skipped in a fresh clone.
const CHART = "public/levels/twilight-zone/chart.json";
it.skipIf(!fs.existsSync(CHART))("single slips cost at most 2 letters", () => {
  const chart = JSON.parse(fs.readFileSync(CHART, "utf8"));
  for (const kind of ["skip", "double", "skipword", "stray2"] as const) {
    const hist = new Map<number, number>();
    const worst: string[] = [];
    const base = new Engine(chart, 1);
    base.lines.forEach((n, li) => {
      const text = base.flat.chars.slice(n.first, n.end).map((c) => c.ch).join("");
      const positions = kind === "skipword"
        ? [...text.matchAll(/(?:^|\s)(\S+)\s/g)].map((m) => [m.index! + (m[0][0] === " " ? 1 : 0), m[1].length + 1])
        : [...text].map((c, i) => [i, 1]).filter(([i]) => i > 0 && text[i] !== " ");
      for (const [i, len] of positions) {
        const typed = kind === "double" ? text.slice(0, i + 1) + text.slice(i)
          : kind === "stray2" ? text.slice(0, i) + "qz" + text.slice(i) // two stray keys
          : text.slice(0, i) + text.slice(i + len);
        const e = new Engine(chart, 1);
        e.update(e.onset(li) - 0.01);
        // jump straight to this line
        while (e.pos < n.first) (e as any).dropRest(e.flat.chars[e.pos].line);
        const drops0 = e.counts.drop;
        let t = e.onset(li);
        for (const ch of typed) { e.key(ch, t); t += 0.001; }
        const dmg = e.counts.typo + (kind === "skipword" ? 0 : e.counts.drop - drops0);
        hist.set(dmg, (hist.get(dmg) ?? 0) + 1);
        if (dmg >= 3 && worst.length < 6) worst.push(`${dmg}: "${typed}"`);
      }
    });
    console.log(kind, JSON.stringify([...hist].sort((a, b) => a[0] - b[0])));
    expect(Math.max(...hist.keys()), `${kind}: ${worst.join(" | ")}`).toBeLessThanOrEqual(kind === "stray2" ? 4 : 2);
  }
}, 60_000); // a few seconds normally; slower when the machine is busy
