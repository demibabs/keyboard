import { difficulty, flatten, loadLevelIds, type Chart } from "./chart";
import { loadLevel, loadLocalIds, loadLyrics, skeleton, type Level } from "./lyrics";
import { h, fmtScore, pct, tier } from "./dom";
import { go, type Screen } from "./main";
import { getBest, settings, saveSettings } from "./settings";
import { messageScreen, playScreen, type AudioSource } from "./play";
import { calibrateScreen } from "./calibrate";
import { editorScreen } from "./editor";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

export async function selectScreen(): Promise<Screen> {
  const [ids, local] = await Promise.all([loadLevelIds(), loadLocalIds()]);
  const levels: Level[] = await Promise.all(ids.map(loadLevel));
  const charts: Chart[] = levels.map(skeleton); // placeholder text: lyrics are fetched when a song is played
  /** where a level's audio comes from: local files (dev) or the YouTube video */
  const sourceOf = (i: number): AudioSource | null => {
    const hasLocal = local.has(levels[i].id), hasYt = !!levels[i].youtube;
    if (hasLocal && hasYt) return settings.audioSource;
    return hasLocal ? "local" : hasYt ? "youtube" : null;
  };
  let sel = Math.max(0, charts.findIndex((c) => c.id === settings.levelId));
  if (!SPEEDS.includes(settings.speed)) settings.speed = 0.75;

  const list = h("div", { class: "song-list" });
  const detail = h("div", { class: "song-detail" });
  const calibrated = settings.audioOffsetMs !== 0 || settings.visualOffsetMs !== 0;

  const el = h("div", { class: "select" },
    h("header", { class: "brand" },
      h("h1", {}, "Key", h("span", {}, "board")),
      h("p", {}, "Type every lyric the moment it's sung.")),
    h("main", { class: "select-main" }, list, detail),
    h("footer", { class: "keys" },
      key("↑↓", "song"), key("←→", "speed"), key("Enter", "play"), key("C", "calibrate"),
      ...(local.size ? [key("A", "audio source"), key("E", "chart editor")] : [])),
  );

  function render() {
    list.replaceChildren(...charts.map((c, i) => {
      const t = tier(difficulty(c, settings.speed).needs);
      return h("button", {
        class: "song-card" + (i === sel ? " selected" : ""),
        onclick: () => { sel = i; render(); },
        ondblclick: play,
      },
        h("span", { class: "song-title" }, c.title),
        h("span", { class: "song-artist" }, c.artist),
        h("span", { class: `tier-chip ${t.cls}` }, t.name));
    }));
    const c = charts[sel];
    if (!c) { detail.replaceChildren(h("p", {}, "No levels found in public/levels.")); return; }
    const diff = difficulty(c, settings.speed);
    const wpm = diff.needs;
    const t = tier(wpm);
    const best = getBest(c.id, settings.speed);
    detail.replaceChildren(
      h("div", { class: "detail-head" },
        h("h2", {}, c.title),
        h("p", { class: "artist" }, c.artist)),
      h("div", { class: "speed-row" }, ...SPEEDS.map((s) =>
        h("button", {
          class: "speed-pill" + (s === settings.speed ? " on" : ""),
          onclick: () => { settings.speed = s; saveSettings(); render(); },
        }, `${s}×`))),
      h("div", { class: "stats" },
        stat("Difficulty", h("span", { class: t.cls }, t.name)),
        stat("Needs", `~${wpm} WPM`),
        stat("Hardest line", `${diff.burst} WPM`),
        stat("Length", `${Math.floor(c.duration / settings.speed / 60)}:${String(Math.round(c.duration / settings.speed % 60)).padStart(2, "0")}`),
        stat("Lines", String(flatten(c).lines.length)),
        stat("Audio", sourceLabel(sourceOf(sel))),
        stat("Best", best ? `${fmtScore(best.score)} · ${best.grade}${best.fc ? " · all clean" : ""} · ${pct(best.accuracy)}` : "—"),
      ),
      h("button", { class: "play-btn", onclick: play }, "Play"),
      calibrated ? "" : h("p", { class: "notice" }, "Timing isn't calibrated yet. Press C to calibrate for accurate judging."),
    );
  }

  function play() {
    const level = levels[sel];
    const source = sourceOf(sel);
    if (!level || !source) return;
    settings.levelId = level.id;
    saveSettings();
    const speed = settings.speed;
    go(async () => {
      let chart: Chart;
      try { chart = await loadLyrics(level); } catch (err) {
        return messageScreen("Couldn't load the lyrics", err instanceof Error ? err.message : String(err));
      }
      return playScreen(chart, speed, source);
    });
  }
  function edit() {
    const level = levels[sel];
    if (!level || !local.has(level.id)) return; // the editor needs the local audio (waveform)
    go(async () => editorScreen(await loadLyrics(level)));
  }

  render();
  return {
    el,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === "ArrowUp" || k === "ArrowDown") {
        sel = (sel + (k === "ArrowUp" ? -1 : 1) + charts.length) % charts.length;
        render(); e.preventDefault();
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        const i = SPEEDS.indexOf(settings.speed) + (k === "ArrowLeft" ? -1 : 1);
        settings.speed = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i))];
        saveSettings(); render(); e.preventDefault();
      } else if (k === "Enter") { play(); e.preventDefault(); }
      else if (k.toLowerCase() === "c") go(() => calibrateScreen());
      else if (k.toLowerCase() === "e") edit();
      else if (k.toLowerCase() === "a" && local.size) {
        settings.audioSource = settings.audioSource === "local" ? "youtube" : "local";
        saveSettings(); render();
      }
    },
  };
}

function sourceLabel(s: AudioSource | null): string {
  return s === "local" ? "Local file" : s === "youtube" ? "YouTube" : "Not available";
}
function key(k: string, label: string) {
  return h("span", {}, h("kbd", {}, k), " ", label);
}
function stat(label: string, value: Node | string) {
  return h("div", { class: "stat" }, h("span", { class: "stat-label" }, label), h("span", { class: "stat-value" }, value));
}
