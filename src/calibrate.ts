// Two tap tests:
//  audio  - tap to clicks you hear (no visuals). Measures audio + input latency -> audioOffsetMs (used for judging).
//  visual - tap to flashes you see (no sound). Measures display + input latency -> visualOffsetMs.
// The game draws visuals (audioOffset - visualOffset) behind the heard audio so both line up.
import { audioCtx, click, heardAt } from "./audio";
import { h } from "./dom";
import { go, type Screen } from "./main";
import { saveSettings, settings } from "./settings";
import { selectScreen } from "./select";

const BEAT = 0.6; // 100 BPM
const WARMUP = 4; // taps ignored at the start
const KEEP = 16;

type Mode = "audio" | "visual";

export function calibrateScreen(): Screen {
  let mode: Mode = "audio";
  let running = false;
  let t0 = 0; // first beat (heard clock for audio, ctx clock for visual)
  let scheduled = 0; // beats scheduled so far (audio)
  let taps: number[] = [];
  let raf = 0;
  let timer = 0;

  const flash = h("div", { class: "cal-flash" });
  const dots = h("div", { class: "cal-dots" }, h("div", { class: "cal-zero" }));
  const measured = h("div", { class: "cal-measured" });
  const instr = h("p", { class: "cal-instr" });
  const tabs = h("div", { class: "cal-tabs" });
  const current = h("div", { class: "cal-current" });

  const el = h("div", { class: "calibrate" },
    h("header", { class: "brand small" }, h("h1", {}, "Calibrate ", h("span", {}, "timing"))),
    tabs,
    h("div", { class: "cal-stage" }, flash, instr, dots, measured),
    current,
    h("footer", { class: "keys" },
      h("span", {}, h("kbd", {}, "Space"), " tap"),
      h("span", {}, h("kbd", {}, "Tab"), " switch test"),
      h("span", {}, h("kbd", {}, "Enter"), " save measured"),
      h("span", {}, h("kbd", {}, "↑↓"), " nudge ±5 ms"),
      h("span", {}, h("kbd", {}, "Esc"), " back")),
  );

  function median(): number | null {
    const xs = taps.slice(WARMUP).slice(-KEEP);
    if (xs.length < 6) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  function render() {
    tabs.replaceChildren(
      h("button", { class: "cal-tab" + (mode === "audio" ? " on" : ""), onclick: () => setMode("audio") }, "1 · Audio"),
      h("button", { class: "cal-tab" + (mode === "visual" ? " on" : ""), onclick: () => setMode("visual") }, "2 · Visual"));
    instr.textContent = !running
      ? (mode === "audio"
        ? "Press Space to start. Tap Space on every click you hear. Don't watch the screen."
        : "Press Space to start. Tap Space every time the circle lights up. There's no sound.")
      : `Keep tapping… (${Math.max(0, taps.length - WARMUP)} / ${KEEP})`;
    const m = median();
    measured.innerHTML = m === null ? "&nbsp;" : `Measured: <b>${Math.round(m * 1000)} ms</b> · Enter to save`;
    current.innerHTML = `Audio offset <b>${settings.audioOffsetMs} ms</b> · Visual offset <b>${settings.visualOffsetMs} ms</b>`;
    dots.querySelectorAll(".cal-dot").forEach((d) => d.remove());
    taps.slice(WARMUP).slice(-KEEP).forEach((t) => {
      const d = h("div", { class: "cal-dot" });
      d.style.left = `${50 + Math.max(-50, Math.min(50, (t / 0.2) * 50))}%`;
      dots.append(d);
    });
    flash.classList.toggle("hidden", mode !== "visual");
  }

  function setMode(m: Mode) {
    stop();
    mode = m;
    render();
  }

  function start() {
    running = true;
    taps = [];
    const c = audioCtx();
    if (mode === "audio") {
      // schedule clicks ahead of time; beat k is heard (on the heard clock) at t0 + k*BEAT
      const ctxStart = c.currentTime + 0.6;
      t0 = ctxStart; // heardNow() reaches the scheduled ctx time when it is heard
      scheduled = 0;
      const sched = () => {
        while (t0 + scheduled * BEAT < c.currentTime + 0.3) {
          click(ctxStart + scheduled * BEAT, scheduled % 4 === 0 ? 1800 : 1200, 0.5);
          scheduled++;
        }
      };
      sched();
      timer = window.setInterval(sched, 50);
    } else {
      t0 = c.currentTime + 0.6;
      const loop = () => {
        raf = requestAnimationFrame(loop);
        const now = audioCtx().currentTime;
        const k = Math.floor((now - t0) / BEAT);
        const since = now - (t0 + k * BEAT);
        flash.classList.toggle("lit", k >= 0 && since < 0.1);
      };
      loop();
    }
    render();
  }

  function stop() {
    running = false;
    clearInterval(timer);
    cancelAnimationFrame(raf);
    flash.classList.remove("lit");
  }

  function tap(e: KeyboardEvent) {
    if (!running) { start(); return; }
    const t = mode === "audio" ? heardAt(e) : audioCtx().currentTime - Math.max(0, performance.now() - e.timeStamp) / 1000;
    const k = Math.round((t - t0) / BEAT);
    if (k < 0) return;
    taps.push(t - (t0 + k * BEAT));
    if (taps.length >= WARMUP + KEEP + 8) taps = taps.slice(-(KEEP + WARMUP));
    render();
  }

  render();
  return {
    el,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " ") { e.preventDefault(); if (!e.repeat) tap(e); }
      else if (e.key === "Tab") { e.preventDefault(); setMode(mode === "audio" ? "visual" : "audio"); }
      else if (e.key === "Enter") {
        const m = median();
        if (m !== null) {
          if (mode === "audio") settings.audioOffsetMs = Math.round(m * 1000);
          else settings.visualOffsetMs = Math.round(m * 1000);
          saveSettings();
          stop();
          render();
        }
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const d = e.key === "ArrowUp" ? 5 : -5;
        if (mode === "audio") settings.audioOffsetMs += d;
        else settings.visualOffsetMs += d;
        saveSettings();
        render();
      } else if (e.key === "Escape") go(() => selectScreen());
    },
    destroy: stop,
  };
}
