import { audioUrl, type Chart } from "./chart";
import { Engine, type EngineEvent } from "./engine";
import { Player, loadBuffer, type GamePlayer } from "./audio";
import { Cancelled, YouTubePlayer } from "./youtube";
import { Sky, loadViz } from "./visuals";
import "./play.css";
import { h, fmtScore, pct } from "./dom";
import { go, navigate, type Screen } from "./main";
import { settings } from "./settings";
import { resultsScreen } from "./results";
import { songMenuScreen } from "./menu/song-menu";

const LEAD_IN = 2.5; // seconds of lead-in before the first line when the song starts with vocals
const SKIP_TO = 1; // Tab skips ahead to this many seconds before the next line (when it's further away)
const SOON = 1.5; // the next-line tag lights up this long before the line starts

interface LineView {
  li: number;
  el: HTMLElement;
  chars: Map<number, HTMLElement>; // char index -> span
}

export type AudioSource = "local" | "youtube";

/** A screen with a message and a way back to the song list (for errors). */
export function messageScreen(title: string, body: string): Screen {
  return {
    el: h("div", { class: "message" }, h("div", { class: "panel" }, h("h2", {}, title), h("p", {}, body),
      h("p", { class: "keys" }, h("kbd", {}, "Enter"), " back to songs"))),
    onKey(e) { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); navigate("play"); } },
  };
}

export async function playScreen(chart: Chart, speed: number, source: AudioSource): Promise<Screen> {
  const engine = new Engine(chart, speed);
  const lines = engine.lines;
  const viz = await loadViz(chart.id); // music features for the sky (null: a calm default sky)
  // lead in only if the first line starts within LEAD_IN seconds
  const startFrom = Math.min(0, (lines.length ? engine.onset(0) : 0) - LEAD_IN);
  let player: GamePlayer;
  if (source === "youtube" && chart.youtube) {
    try {
      player = await YouTubePlayer.open(chart.youtube, speed, chart.duration / speed, settings.volume, startFrom);
    } catch (err) {
      if (err instanceof Cancelled) return songMenuScreen();
      return messageScreen("Couldn't play the video", err instanceof Error ? err.message : String(err));
    }
  } else {
    player = new Player(await loadBuffer(audioUrl(chart, speed)), settings.volume);
  }
  // no latency calibration: lines stay open for seconds, so a few tens of ms of device lag don't matter
  const judgeNow = () => player.time();
  const visNow = () => player.time();

  // ---------- DOM ----------
  const scoreEl = h("div", { class: "hud-score" }, "0");
  const accEl = h("div", { class: "hud-acc" }, "100.0%");
  const linesEl = h("div", { class: "hud-lines" });
  const prevSlot = h("div", { class: "slot prev" });
  const curSlot = h("div", { class: "slot cur" });
  const lineTimer = h("div", { class: "line-timer" }, h("div", { class: "line-timer-fill" }));
  const nextTagTime = h("b", {});
  const nextTag = h("div", { class: "next-tag" }, h("span", {}, "Next"), nextTagTime);
  const nextLine = h("div", { class: "next-line" });
  const nextSlot = h("div", { class: "slot next" }, nextTag, nextLine);
  const ready = h("div", { class: "ready hidden" }, h("div", { class: "ready-bar" }), h("span", { class: "ready-text" }));
  const hint = h("div", { class: "play-hint" });
  const note = chart.note ? h("div", { class: "play-note" }, chart.note) : "";
  const progress = h("div", { class: "progress-fill" });
  const timeEl = h("span", { class: "time" });
  const pauseMenu = h("div", { class: "overlay hidden" },
    h("div", { class: "panel" },
      h("h2", {}, "Paused"),
      h("p", {}, h("kbd", {}, "Esc"), " resume  ", h("kbd", {}, "R"), " restart  ", h("kbd", {}, "Q"), " quit")));

  const skyCanvas = h("canvas", { class: "sky-canvas", "aria-hidden": "true" });
  const el = h("div", { class: "play" },
    skyCanvas,
    h("header", { class: "hud" },
      h("div", { class: "hud-left" },
        h("div", { class: "hud-title" }, chart.title),
        h("div", { class: "hud-sub" }, `${chart.artist} · ${speed}×`)),
      h("div", { class: "hud-right" }, scoreEl, h("div", { class: "hud-row" }, linesEl, accEl))),
    note,
    h("main", { class: "stage" }, prevSlot, h("div", { class: "cur-wrap" }, ready, curSlot, lineTimer), nextSlot, hint),
    h("footer", { class: "play-foot" }, h("div", { class: "progress" }, progress), timeEl),
    pauseMenu,
  );

  // ---------- lines ----------
  const views = new Map<number, LineView>();
  function view(li: number): LineView {
    let v = views.get(li);
    if (v) return v;
    const l = lines[li];
    const lineEl = h("div", { class: "lyric-line" });
    const charMap = new Map<number, HTMLElement>();
    // letters of a word go in one unbreakable group, so a long line only wraps between words
    let word: HTMLElement | null = null;
    for (let i = 0; i < l.text.length; i++) {
      const c = l.text[i];
      const idx = l.map[i];
      const cls = l.paren[i] ? "ch paren" : idx >= 0 ? (engine.flat.chars[idx].kind === "space" ? "ch space" : "ch") : "ch punct";
      const gap = /\s/.test(c);
      const span = h("span", { class: cls }, gap ? "\u00a0" : c);
      if (idx >= 0) charMap.set(idx, span);
      if (gap) {
        word = null;
        lineEl.append(span); // spaces sit between words: the only places a line can wrap
      } else {
        if (!word) lineEl.append((word = h("span", { class: "word" })));
        word.append(span);
      }
    }
    v = { li, el: lineEl, chars: charMap };
    views.set(li, v);
    return v;
  }

  let shownLine = -2;
  function showLine(li: number) {
    if (li === shownLine) return;
    shownLine = li;
    prevSlot.replaceChildren(...(li > 0 ? [view(li - 1).el] : []));
    curSlot.replaceChildren(view(li).el);
    nextLine.replaceChildren(...(li + 1 < lines.length ? [view(li + 1).el] : []));
    nextSlot.classList.toggle("hidden", li + 1 >= lines.length);
    curSlot.classList.remove("enter");
    void curSlot.offsetWidth;
    curSlot.classList.add("enter");
    views.forEach((_, k) => { if (k < li - 1) views.delete(k); });
    repaint();
  }

  function paintChars(v: LineView) {
    v.chars.forEach((cEl, idx) => {
      const base = engine.flat.chars[idx].kind === "space" ? "ch space" : "ch";
      cEl.className = `${base} ${engine.charState[idx]}${idx === engine.pos ? " cursor" : ""}`;
    });
  }
  function repaint() {
    for (const k of [shownLine - 1, shownLine, shownLine + 1]) {
      const v = views.get(k);
      if (v) paintChars(v);
    }
  }

  // ---------- feedback ----------
  /** popup above a char (defaults to the cursor, or the line's first char) */
  function popup(li: number, text: string, cls: string, charIdx = lines[li].first) {
    const v = views.get(li);
    const anchor = v?.chars.get(charIdx);
    if (!v || !anchor || !v.el.isConnected) return;
    const base = v.el.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const p = h("div", { class: `pop ${cls}` }, text);
    p.style.left = `${r.left - base.left + r.width / 2}px`;
    p.style.top = `${r.top - base.top}px`;
    p.addEventListener("animationend", () => p.remove());
    v.el.append(p);
  }
  function handle(ev: EngineEvent) {
    switch (ev.type) {
      case "line": {
        const r = ev.result;
        const label = `${r.clean ? "Clean! " : ""}+${Math.round(r.bonus)}${r.speed >= 0.5 ? " fast" : ""}`;
        popup(ev.line, label, r.clean ? "j-clean" : "j-done", lines[ev.line].end - 1);
        if (r.clean) { // sparkles from the end of a clean line
          const at = views.get(ev.line)?.chars.get(lines[ev.line].end - 1)?.getBoundingClientRect();
          if (at) sky?.burst(at.right, at.top + at.height / 2);
        }
        break;
      }
      case "resync":
        popup(ev.line, "re-synced", "j-resync", Math.max(lines[ev.line].first, ev.pos - 1));
        if (import.meta.env.DEV) (window as any).__resyncs = ((window as any).__resyncs ?? 0) + 1;
        break;
      case "early":
        popup(ev.line, "not yet", "j-early");
        break;
    }
  }

  // ---------- loop ----------
  let raf = 0;
  let paused = false;
  let done = false;
  let shownScore = 0;
  let lastPos = -1;
  const lastDeadline = lines.length ? engine.deadline(lines.length - 1) : 0;

  let sky: Sky | null = null;
  let lastFrame = performance.now();
  function frame() {
    raf = requestAnimationFrame(frame);
    const nowMs = performance.now();
    const dt = (nowMs - lastFrame) / 1000;
    lastFrame = nowMs;
    if (paused) return;
    // the sky follows the song: player time is real seconds at this speed; the music data is at 1x
    sky?.frame(player.time() * speed, dt);
    const jt = judgeNow();
    const vt = visNow();
    engine.update(jt);
    const evs = engine.events;
    engine.events = [];
    evs.forEach(handle);

    const cl = engine.cursorLine;
    const li = cl >= 0 ? cl : lines.length - 1;
    if (li < 0) return;
    showLine(li);
    if (evs.length || engine.pos !== lastPos) { repaint(); lastPos = engine.pos; }

    const atStart = cl >= 0 && engine.pos === lines[cl].first;
    const start = engine.onset(li);
    const close = engine.deadline(li);

    // first letter glows once the line is open and waiting to be started
    const firstEl = views.get(li)?.chars.get(lines[li].first);
    firstEl?.classList.toggle("open", atStart && jt >= engine.opens(li) && jt < close);
    // finished lines show how they went
    const pv = views.get(li - 1);
    const pr = li > 0 ? engine.lineResult[li - 1] : null;
    if (pv && pr) pv.el.dataset.result = pr.clean ? "clean" : pr.done ? "done" : "dropped";

    // before the line starts: get-ready countdown; once it's open: time left until it closes
    const wait = start - vt;
    if (atStart && wait > 0.15) {
      const prevEnd = li > 0 ? engine.deadline(li - 1) : 0;
      const total = Math.min(4, Math.max(1, start - Math.min(prevEnd, start - 1)));
      ready.classList.remove("hidden");
      (ready.firstChild as HTMLElement).style.transform = `scaleX(${Math.min(1, wait / total)})`;
      (ready.lastChild as HTMLElement).textContent = wait <= 3 ? `starts in ${wait.toFixed(1)}s` : "get ready";
      lineTimer.style.opacity = "0";
    } else {
      ready.classList.add("hidden");
      if (cl >= 0 && jt >= engine.opens(li)) {
        const left = Math.max(0, close - jt);
        lineTimer.style.opacity = "1";
        (lineTimer.firstChild as HTMLElement).style.transform = `scaleX(${Math.min(1, left / Math.max(0.01, close - start))})`;
        lineTimer.classList.toggle("low", left < 1);
      } else lineTimer.style.opacity = "0";
    }

    // next line: how soon it starts
    if (li + 1 < lines.length) {
      const until = engine.onset(li + 1) - vt;
      nextTagTime.textContent = until > 0 ? `in ${until.toFixed(1)}s` : "now";
      nextSlot.classList.toggle("soon", until <= SOON);
    }

    // hints
    if (atStart && start - jt > SKIP_TO + 0.5) hint.innerHTML = "<kbd>Tab</kbd> skip ahead";
    else if (engine.finished && jt > lastDeadline - 1) hint.innerHTML = "<kbd>Enter</kbd> results";
    else hint.textContent = "";

    // HUD
    shownScore += (engine.score - shownScore) * 0.25;
    if (Math.abs(engine.score - shownScore) < 1) shownScore = engine.score;
    scoreEl.textContent = fmtScore(shownScore);
    accEl.textContent = pct(engine.accuracy());
    linesEl.innerHTML = `<b>${engine.counts.clean}</b> clean · ${engine.counts.lines} done`;
    const t = player.time();
    progress.style.transform = `scaleX(${Math.max(0, Math.min(1, t / player.duration))})`;
    timeEl.textContent = `${fmt(t)} / ${fmt(player.duration)}`;
  }

  function fmt(s: number) {
    s = Math.max(0, s);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  // ---------- control ----------
  function pause() {
    if (paused || done) return;
    paused = true;
    player.pause();
    pauseMenu.classList.remove("hidden");
  }
  function resume() {
    if (!paused) return;
    paused = false;
    pauseMenu.classList.add("hidden");
    player.resume(0.3);
  }
  function finish() {
    if (done) return;
    done = true;
    engine.update(Infinity);
    player.stop();
    go(() => resultsScreen(chart, speed, engine, source));
  }
  /** Jump ahead to SKIP_TO seconds before the next line, if it's further away than that. Only while
   * waiting for a line (intro, gaps, or a line finished early): does nothing while a line can be typed. */
  function skip() {
    const cl = engine.cursorLine;
    if (cl < 0) return;
    const now = judgeNow();
    if (now >= engine.opens(cl)) return; // the cursor's line is open: keep typing
    const gap = engine.onset(cl) - now;
    if (gap > SKIP_TO) player.play(player.time() + gap - SKIP_TO, 0.05);
  }
  const onBlur = () => pause();
  window.addEventListener("blur", onBlur);
  player.onEnded = finish;

  player.play(startFrom, 0.2);
  raf = requestAnimationFrame(frame);
  requestAnimationFrame(() => { // once the canvas is laid out
    sky = new Sky(skyCanvas, el, viz);
    if (import.meta.env.DEV) (window as any).__sky = sky;
  });
  if (import.meta.env.DEV) (window as any).__play = { engine, player, aOff: 0, skip };

  return {
    el,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (paused) {
        e.preventDefault();
        if (k === "Escape" || k === "Enter") resume();
        else if (k.toLowerCase() === "r") go(() => playScreen(chart, speed, source));
        else if (k.toLowerCase() === "q") navigate("play");
        return;
      }
      if (k === "Escape") { e.preventDefault(); pause(); return; }
      if (k === "Tab") { e.preventDefault(); skip(); return; }
      if (k === "Enter") { e.preventDefault(); if (engine.finished) finish(); return; }
      if (e.repeat) return;
      const ch = k.length === 1 ? k.toLowerCase() : "";
      if (/^[a-z0-9 -]$/.test(ch)) {
        e.preventDefault();
        engine.key(ch, player.timeOf(e));
        const evs = engine.events;
        engine.events = [];
        evs.forEach(handle);
        repaint();
        lastPos = engine.pos;
      } else if (k.length === 1) e.preventDefault(); // punctuation isn't typed; swallow quick-find keys
    },
    destroy() {
      sky?.dispose();
      cancelAnimationFrame(raf);
      window.removeEventListener("blur", onBlur);
      player.onEnded = null;
      player.dispose();
    },
  };
}
