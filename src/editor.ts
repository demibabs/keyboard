// Chart editor: fix line start times by ear. Timeline with the song's waveform, drag/nudge line markers,
// tap mode (tap each line start while the song plays), click track, save to disk (dev server).
import { audioUrl, type Chart, type ChartLine } from "./chart";
import { Player, audioCtx, click, loadBuffer } from "./audio";
import { h } from "./dom";
import { navigate, type Screen } from "./main";
import { settings } from "./settings";

const SPEEDS = [0.5, 0.75, 1];
const MIN_GAP = 0.05;

/** RMS envelope of an AudioBuffer at `rate` frames per second of audio, normalised to 0..1 */
function envelope(buf: AudioBuffer, rate = 100): number[] {
  const ch = buf.getChannelData(0);
  const hop = Math.floor(buf.sampleRate / rate);
  const out: number[] = [];
  let max = 1e-9;
  for (let i = 0; i + hop <= ch.length; i += hop) {
    let s = 0;
    for (let k = i; k < i + hop; k++) s += ch[k] * ch[k];
    const v = Math.sqrt(s / hop);
    out.push(v);
    if (v > max) max = v;
  }
  return out.map((v) => v / max);
}

export async function editorScreen(source: Chart): Promise<Screen> {
  const chart: Chart = JSON.parse(JSON.stringify(source));
  const L: ChartLine[] = chart.lines;
  const original = L.map((l) => l.t);
  const off = (chart.offsetMs || 0) / 1000;

  let speed = 0.5;
  let player = new Player(await loadBuffer(audioUrl(chart, speed)), settings.volume);
  const full = await loadBuffer(audioUrl(chart, 1));
  const env = envelope(full); // indexed by chart seconds * 100
  let sel = 0;
  let head = Math.max(0, (L[0]?.t ?? 0) - 1); // playhead (chart time) while paused
  let zoom = 12; // seconds of chart time across the timeline
  let center = head + 4;
  let tapMode = false;
  let clickTrack = true;
  let dirty = false;
  const undo: number[][] = [];

  // ---------- DOM ----------
  const canvas = h("canvas", { class: "ed-canvas" });
  const info = h("div", { class: "ed-info" });
  const status = h("div", { class: "ed-status" });
  const list = h("div", { class: "ed-lyrics" });
  const toolbar = h("div", { class: "ed-toolbar" });
  const el = h("div", { class: "editor" },
    h("header", { class: "ed-head" },
      h("h1", {}, "Chart editor ", h("span", {}, chart.title)), toolbar),
    canvas, info, list, status,
    h("footer", { class: "keys" },
      key("Space", "play/pause"), key("Enter", "play from selected"), key("↑↓", "select line"),
      key("[ ]", "nudge 10 ms (Shift 50)"), key("T", "tap mode"), key("F/J", "tap"), key("C", "click track"),
      key("1-3", "speed"), key("Ctrl+Z", "undo"), key("Ctrl+S", "save"), key("Esc", "back")),
  );

  function renderToolbar() {
    toolbar.replaceChildren(
      ...SPEEDS.map((s, i) => h("button", { class: "speed-pill" + (s === speed ? " on" : ""), onclick: () => setSpeed(s), title: `key ${i + 1}` }, `${s}×`)),
      h("button", { class: "tool" + (tapMode ? " on" : ""), onclick: toggleTap }, tapMode ? "Tap mode ON" : "Tap mode"),
      h("button", { class: "tool" + (clickTrack ? " on" : ""), onclick: () => { clickTrack = !clickTrack; renderToolbar(); } }, "Click track"),
      h("button", { class: "tool", onclick: save }, dirty ? "Save*" : "Save"),
    );
  }

  function renderList() {
    list.replaceChildren(...L.map((l, i) =>
      h("button", {
        class: "ed-row", "data-i": i,
        onclick: () => { select(i, true); if (!player.playing) head = Math.max(0, l.t - 0.5); },
      }, h("span", { class: "ed-time" }), h("span", { class: "ed-text" + (l.text ? "" : " blank") }, l.text || "— end of vocals —"))));
    paintList();
  }

  function paintList() {
    list.querySelectorAll<HTMLElement>(".ed-row").forEach((r) => {
      const i = Number(r.dataset.i);
      r.classList.toggle("sel", i === sel);
      r.classList.toggle("edited", Math.abs(L[i].t - original[i]) > 0.0005);
      (r.firstChild as HTMLElement).textContent = fmt(L[i].t);
    });
    list.querySelector<HTMLElement>(`.ed-row[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function renderInfo() {
    const l = L[sel];
    if (!l) { info.textContent = ""; return; }
    const moved = l.t - original[sel];
    info.innerHTML = `Line ${sel + 1}: <b>${escape(l.text || "end of vocals")}</b> at <b>${l.t.toFixed(2)} s</b>` +
      (L[sel + 1] ? ` · open for ${(L[sel + 1].t - l.t).toFixed(2)} s` : "") +
      (Math.abs(moved) > 0.0005 ? ` · moved ${moved > 0 ? "+" : ""}${Math.round(moved * 1000)} ms` : "");
  }

  // ---------- time ----------
  const chartTime = (pos: number) => pos * speed - off;
  const posOf = (t: number) => (t + off) / speed;
  function nowChart(): number {
    return player.playing ? chartTime(player.time()) : head;
  }
  function play(fromChart: number) {
    head = Math.max(0, fromChart);
    player.play(posOf(head), 0.1);
    scheduled.clear();
  }
  function pause() {
    if (!player.playing) return;
    head = chartTime(player.time());
    player.stop();
  }
  async function setSpeed(s: number) {
    if (s === speed) return;
    const was = player.playing;
    const at = nowChart();
    pause();
    speed = s;
    status.textContent = "loading audio…";
    const buf = await loadBuffer(audioUrl(chart, speed));
    player.dispose();
    player = new Player(buf, settings.volume);
    status.textContent = "";
    head = at;
    if (was) play(at);
    renderToolbar();
  }

  // ---------- editing ----------
  function snapshot() { undo.push(L.map((l) => l.t)); if (undo.length > 200) undo.shift(); }
  function setTime(i: number, t: number) {
    const lo = i > 0 ? L[i - 1].t + MIN_GAP : 0;
    const hi = i + 1 < L.length ? L[i + 1].t - MIN_GAP : chart.duration;
    L[i].t = Math.round(Math.min(hi, Math.max(lo, t)) * 1000) / 1000;
    dirty = true;
    renderToolbar();
  }
  function select(i: number, centerView = false) {
    sel = Math.max(0, Math.min(L.length - 1, i));
    if (centerView && !player.playing) center = L[sel].t + zoom * 0.3;
    paintList();
    renderInfo();
  }
  function toggleTap() {
    tapMode = !tapMode;
    status.textContent = tapMode ? "Tap mode: play the song and press F or J as each line starts, beginning with the selected one." : "";
    renderToolbar();
  }

  async function save() {
    chart.version = (chart.version || 1) + 1;
    const body = JSON.stringify(chart);
    try {
      const r = await fetch("/api/save-chart", { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      status.textContent = `Saved to public/levels/${chart.id}/chart.json (first save keeps chart.orig.json)`;
      dirty = false;
      Object.assign(source, JSON.parse(body));
    } catch (err) {
      const a = h("a", { href: URL.createObjectURL(new Blob([body], { type: "application/json" })), download: "chart.json" });
      a.click();
      status.textContent = `Couldn't save through the dev server (${err}); downloaded chart.json instead.`;
    }
    renderToolbar();
  }

  // ---------- timeline ----------
  const g = canvas.getContext("2d")!;
  let W = 0, H = 0;
  const css = getComputedStyle(document.documentElement);
  const col = (n: string) => css.getPropertyValue(n).trim();
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const x2t = (x: number) => center - zoom / 2 + (x / W) * zoom;
  const t2x = (t: number) => ((t - (center - zoom / 2)) / zoom) * W;

  function draw() {
    if (!W) resize();
    const now = nowChart();
    if (player.playing) center = now + zoom * 0.3;
    g.fillStyle = col("--bg2");
    g.fillRect(0, 0, W, H);
    const t0 = center - zoom / 2, t1 = center + zoom / 2;
    // line spans
    L.forEach((l, i) => {
      if (!l.text) return;
      const end = L[i + 1]?.t ?? chart.duration;
      if (end < t0 || l.t > t1) return;
      g.fillStyle = i % 2 ? col("--band-a") : col("--band-b");
      g.fillRect(t2x(l.t), 0, t2x(end) - t2x(l.t), H);
    });
    // waveform envelope
    g.fillStyle = col("--env");
    const mid = H * 0.6;
    for (let x = 0; x < W; x += 2) {
      const v = env[Math.floor((x2t(x) + off) * 100)] ?? 0;
      const hh = v * H * 0.55;
      g.fillRect(x, mid - hh / 2, 2, hh);
    }
    // seconds
    g.fillStyle = col("--dim");
    g.font = "11px Outfit, system-ui, sans-serif";
    const step = zoom > 20 ? 5 : 1;
    for (let s = Math.ceil(t0 / step) * step; s <= t1; s += step) {
      const x = t2x(s);
      g.fillRect(x, H - 8, 1, 8);
      g.fillText(`${s}s`, x + 3, H - 2);
    }
    // markers
    g.font = "600 13px Outfit, system-ui, sans-serif";
    L.forEach((l, k) => {
      const x = t2x(l.t);
      if (x < -300 || x > W + 10) return;
      const isSel = k === sel;
      const moved = Math.abs(l.t - original[k]) > 0.0005;
      g.fillStyle = isSel ? col("--accent2") : moved ? col("--great") : l.text ? col("--accent") : col("--dim");
      g.fillRect(x - (isSel ? 1 : 0.5), 6, isSel ? 2 : 1, H - 18);
      g.beginPath(); g.moveTo(x - 6, 6); g.lineTo(x + 6, 6); g.lineTo(x, 14); g.fill();
      g.fillStyle = isSel ? col("--accent2") : col("--text");
      const end = Math.min(W, t2x(L[k + 1]?.t ?? chart.duration)) - 6;
      const label = l.text || "end";
      g.save();
      g.beginPath(); g.rect(x, 0, Math.max(0, end - x), H); g.clip();
      g.fillText(label, x + 6, 26);
      g.restore();
    });
    // playhead
    g.fillStyle = col("--miss");
    g.fillRect(t2x(now) - 1, 0, 2, H);
  }

  // drag / seek
  let dragging = -1;
  canvas.addEventListener("pointerdown", (e) => {
    const x = e.offsetX;
    let best = -1, bd = 8;
    L.forEach((l, k) => { const d = Math.abs(t2x(l.t) - x); if (d < bd) { bd = d; best = k; } });
    if (best >= 0) {
      snapshot();
      dragging = best;
      select(best);
      canvas.setPointerCapture(e.pointerId);
    } else {
      const t = x2t(x);
      if (player.playing) play(t); else head = t;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging < 0) return;
    setTime(dragging, x2t(e.offsetX));
    renderInfo();
  });
  canvas.addEventListener("pointerup", () => {
    if (dragging >= 0) { dragging = -1; paintList(); renderInfo(); }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      if (!player.playing) center += ((e.deltaX || e.deltaY) / W) * zoom;
      return;
    }
    const t = x2t(e.offsetX);
    zoom = Math.min(60, Math.max(2, zoom * Math.exp(e.deltaY * 0.0015)));
    if (!player.playing) center = t - (e.offsetX / W - 0.5) * zoom;
  }, { passive: false });

  // click track on line starts
  const scheduled = new Set<number>();
  function scheduleClicks() {
    if (!clickTrack || !player.playing) return;
    const c = audioCtx();
    const pos = player.time();
    L.forEach((l, k) => {
      const p = posOf(l.t);
      if (p >= pos && p < pos + 0.25 && !scheduled.has(k)) {
        scheduled.add(k);
        click(Math.max(c.currentTime, player.clockAt(p)), l.text ? 2200 : 1000, 0.3);
      }
    });
  }

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    scheduleClicks();
    draw();
    if (player.playing && !tapMode) {
      const t = nowChart();
      let k = sel;
      while (k + 1 < L.length && L[k + 1].t <= t) k++;
      while (k > 0 && L[k].t > t) k--;
      if (k !== sel) select(k);
    }
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  renderToolbar();
  renderList();
  renderInfo();
  raf = requestAnimationFrame(loop);

  return {
    el,
    onKey(e) {
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") {
        e.preventDefault();
        const prev = undo.pop();
        if (prev) { prev.forEach((t, i) => (L[i].t = t)); dirty = true; paintList(); renderInfo(); renderToolbar(); }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "s") { e.preventDefault(); void save(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === " ") { e.preventDefault(); if (player.playing) pause(); else play(head); }
      else if (k === "Enter") { e.preventDefault(); play(L[sel].t - 1.5); }
      else if (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        select(sel + (k === "ArrowUp" || k === "ArrowLeft" ? -1 : 1), true);
      } else if (e.code === "BracketLeft" || e.code === "BracketRight") {
        e.preventDefault();
        snapshot();
        setTime(sel, L[sel].t + (e.code === "BracketLeft" ? -1 : 1) * (e.shiftKey ? 0.05 : 0.01));
        paintList(); renderInfo();
      } else if (k.toLowerCase() === "t") toggleTap();
      else if (k.toLowerCase() === "c") { clickTrack = !clickTrack; renderToolbar(); }
      else if (k >= "1" && k <= "3") void setSpeed(SPEEDS[Number(k) - 1]);
      else if (tapMode && (k.toLowerCase() === "f" || k.toLowerCase() === "j") && player.playing && !e.repeat) {
        e.preventDefault();
        snapshot();
        setTime(sel, chartTime(player.timeOf(e)));
        scheduled.add(sel);
        select(sel + 1);
      } else if (k === "Escape") {
        if (dirty && !confirm("Leave without saving your timing changes?")) return;
        navigate("play");
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      player.dispose();
    },
  };
}

function fmt(t: number) {
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;
}
function key(k: string, label: string) {
  return h("span", {}, h("kbd", {}, k), " ", label);
}
function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
