import type { Chart } from "./chart";
import { Engine, grade } from "./engine";
import { h, fmtScore, pct } from "./dom";
import { go, type Screen } from "./main";
import { recordBest } from "./settings";
import { playScreen, type AudioSource } from "./play";
import { selectScreen } from "./select";

export function resultsScreen(chart: Chart, speed: number, engine: Engine, source: AudioSource): Screen {
  const acc = engine.accuracy(true);
  const g = grade(acc);
  const allClean = engine.allClean;
  const score = Math.round(engine.score);
  const isBest = recordBest(chart.id, speed, { score, grade: g, accuracy: acc, fc: allClean });
  const c = engine.counts;
  const n = engine.lines.length;
  const fast = engine.lineResult.filter((r) => r?.done);
  const avgSpeed = fast.length ? fast.reduce((s, r) => s + r!.speed, 0) / fast.length : 0;

  const el = h("div", { class: "results" },
    h("div", { class: "results-head" },
      h("div", { class: `grade g-${g}` }, g),
      h("div", {},
        h("h2", {}, chart.title),
        h("p", { class: "artist" }, `${chart.artist} · ${speed}×`),
        h("div", { class: "big-score" }, fmtScore(score)),
        h("div", { class: "badges" },
          isBest ? h("span", { class: "badge best" }, "New best") : null,
          allClean ? h("span", { class: "badge fc" }, "Every line clean") : null))),
    h("div", { class: "results-grid" },
      row("Accuracy", pct(acc)),
      row("WPM while lines were open", String(Math.round(engine.wpm()))),
      row("Lines finished", `${c.lines} / ${n}`),
      row("Clean lines", `${c.clean} / ${n}`),
      row("Correct letters", String(c.ok)),
      row("Autocorrected letters", String(c.fixed)),
      row("Wrong letters", String(c.typo)),
      row("Dropped letters", String(c.drop)),
      row("Missed spaces", String(c.spaceMiss)),
      row("Avg. finish speed", fast.length ? `${Math.round(avgSpeed * 100)}% of the line's time left` : "—"),
    ),
    h("footer", { class: "keys" },
      h("span", {}, h("kbd", {}, "R"), " retry"),
      h("span", {}, h("kbd", {}, "Enter"), " song select")),
  );

  return {
    el,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() === "r") go(() => playScreen(chart, speed, source));
      else if (e.key === "Enter" || e.key === "Escape") go(() => selectScreen());
    },
  };
}

function row(label: string, value: string) {
  return h("div", { class: "res-row" }, h("span", {}, label), h("b", {}, value));
}
