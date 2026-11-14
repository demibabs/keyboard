// Song menu mockup D, "Star chart": every song is a star. Across: the WPM it needs at the chosen speed,
// in five equal-width tier bands; down: how long it is. Stars in a tier are joined into a constellation
// (a minimum spanning tree). A side panel shows the selected song; a list view is one click away.
import "./mock-d.css";
import { h, fmtScore, pct } from "../dom";
import { navigate, type Screen } from "../main";
import { navbar, sky } from "../landing";
import { settings, saveSettings } from "../settings";
import {
  bestOf, difficultyOf, lengthAt, loadSongs, matches, sourceFor, startSong, SPEEDS, TIERS,
} from "./songs";

const SVG = "http://www.w3.org/2000/svg";
const EDGES = [45, 70, 100, 140]; // tier boundaries (WPM), as in dom.tier()
const PAD = { l: 52, r: 22, t: 36, b: 46 };
const MIN_GAP = 17; // px between star centres (each star's hit area is 22px)
const TWEEN_MS = 650;
const TIER_CLS = ["t-easy", "t-normal", "t-hard", "t-expert", "t-insane"];

interface Pt { x: number; y: number }
const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Minimum spanning tree (Prim) over points: the faint lines of a constellation. */
function mst(idx: number[], pos: Pt[]): [number, number][] {
  if (idx.length < 2) return [];
  const inTree = new Set([idx[0]]);
  const edges: [number, number][] = [];
  while (inTree.size < idx.length) {
    let best: [number, number] | null = null, bd = Infinity;
    for (const a of inTree) for (const b of idx) {
      if (inTree.has(b)) continue;
      const d = (pos[a].x - pos[b].x) ** 2 + (pos[a].y - pos[b].y) ** 2;
      if (d < bd) { bd = d; best = [a, b]; }
    }
    edges.push(best!);
    inTree.add(best![1]);
  }
  return edges;
}

export async function mockDScreen(): Promise<Screen> {
  const songs = await loadSongs();
  let speed = SPEEDS.includes(settings.speed) ? settings.speed : 1;
  let query = "";
  let view: "chart" | "list" = "chart";
  let sel = songs.findIndex((s) => s.id === settings.levelId);
  if (sel < 0) sel = order()[0] ?? 0;

  // fixed WPM domain across all speeds, so stars visibly migrate between tiers as the speed changes
  const allNeeds = songs.flatMap((s) => [difficultyOf(s, SPEEDS[0]).needs, difficultyOf(s, SPEEDS[SPEEDS.length - 1]).needs]);
  const bounds = [Math.min(20, Math.min(...allNeeds) - 3), ...EDGES, Math.max(180, Math.max(...allNeeds) + 6)];
  const durs = songs.map((s) => s.duration);
  const dMin = Math.floor(Math.min(...durs) / 30) * 30, dMax = Math.ceil(Math.max(...durs) / 30) * 30;

  function order(): number[] { // songs by difficulty at the current speed
    return songs.map((_, i) => i).sort((a, b) => difficultyOf(songs[a], speed).needs - difficultyOf(songs[b], speed).needs);
  }
  const hits = () => songs.map((s) => matches(s, query));

  // ---------- DOM ----------
  const search = h("input", { class: "md-search", type: "search", placeholder: "Search songs or artists", "aria-label": "Search songs", spellcheck: "false" });
  const count = h("span", { class: "md-count" });
  const chartBtn = h("button", { class: "md-seg on", onclick: () => setView("chart") }, "Chart");
  const listBtn = h("button", { class: "md-seg", onclick: () => setView("list") }, "List");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "md-lines");
  const guides = h("div", { class: "md-guides", "aria-hidden": "true" });
  const starLayer = h("div", { class: "md-stars", role: "listbox", "aria-label": "Songs" });
  const tip = h("div", { class: "md-tip", "aria-hidden": "true" });
  const chart = h("div", { class: "md-chart" }, guides, svg, starLayer, tip);
  const list = h("div", { class: "md-list hidden", role: "listbox", "aria-label": "Songs by difficulty" });
  const panel = h("aside", { class: "md-panel" });

  const el = h("div", { class: "landing md-page" },
    sky(), navbar(),
    h("section", { class: "md-wrap" },
      h("div", { class: "md-main" },
        h("header", { class: "md-bar" },
          h("div", { class: "md-heading" }, h("h1", {}, "Star chart"), h("p", {}, "Easier songs to the left, longer ones lower down.")),
          h("div", { class: "md-tools" },
            h("label", { class: "md-search-wrap" }, h("span", { class: "md-search-key", "aria-hidden": "true" }, "/"), search, count),
            h("div", { class: "md-segs", role: "group", "aria-label": "View" }, chartBtn, listBtn))),
        chart, list),
      panel));

  // ---------- stars ----------
  const stars = songs.map((s, i) => {
    const b = h("button", { class: "md-star", role: "option", "aria-label": `${s.title} by ${s.artist}` }, h("span", { class: "md-dot" }));
    const r = 2.2 + Math.min(1, s.lines / 70) * 2.6; // bigger star = more lines
    b.style.setProperty("--r", `${r.toFixed(2)}px`);
    b.addEventListener("mouseenter", () => showTip(i));
    b.addEventListener("mouseleave", hideTip);
    b.addEventListener("focus", () => showTip(i));
    b.addEventListener("blur", hideTip);
    b.addEventListener("click", () => select(i));
    b.addEventListener("dblclick", () => startSong(songs[i], speed));
    starLayer.append(b);
    return b;
  });

  let W = 0, H = 0;
  let shown: Pt[] = songs.map(() => ({ x: 0, y: 0 }));
  /** band edges as fractions 0..1 of the chart width: a base share each, plus room for the songs in it */
  function bandEdges(): number[] {
    const n = TIERS.map((t) => songs.filter((s) => difficultyOf(s, speed).tier === t).length);
    const w = n.map((c) => 1 + (4 * c) / songs.length);
    const total = w.reduce((a, b) => a + b, 0);
    const e = [0];
    w.forEach((x) => e.push(e[e.length - 1] + x / total));
    return e;
  }
  let bandsAt = bandEdges();
  let edges: [number, number][] = [];
  let lineEls: SVGLineElement[] = [];
  let raf = 0;

  function xOf(needs: number): number {
    let i = 0;
    while (i < 4 && needs >= bounds[i + 1]) i++;
    const f = Math.max(0, Math.min(1, (needs - bounds[i]) / (bounds[i + 1] - bounds[i])));
    const frac = bandsAt[i] + f * (bandsAt[i + 1] - bandsAt[i]);
    return PAD.l + frac * (W - PAD.l - PAD.r);
  }
  const yOf = (d: number) => PAD.t + ((d - dMin) / (dMax - dMin)) * (H - PAD.t - PAD.b);

  function targets(): Pt[] {
    const p = songs.map((s) => ({ x: xOf(difficultyOf(s, speed).needs), y: yOf(s.duration) }));
    // nudge apart stars that would sit on top of each other (mostly vertically, keeping x honest)
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (let a = 0; a < p.length; a++) for (let b = a + 1; b < p.length; b++) {
        const dx = p[b].x - p[a].x, dy = p[b].y - p[a].y, d = Math.hypot(dx, dy);
        if (d >= MIN_GAP) continue;
        moved = true;
        const push = (MIN_GAP - d) / 2;
        const ux = d ? dx / d : 0, uy = d ? dy / d : (a % 2 ? 1 : -1);
        p[a].x -= ux * push * 0.35; p[b].x += ux * push * 0.35;
        p[a].y -= uy * push; p[b].y += uy * push;
      }
      if (!moved) break;
    }
    for (const q of p) { q.x = Math.max(PAD.l + 4, Math.min(W - PAD.r - 4, q.x)); q.y = Math.max(PAD.t + 4, Math.min(H - PAD.b - 4, q.y)); }
    return p;
  }

  const bandEls = TIERS.map((_, i) => h("div", { class: `md-band${i % 2 ? " alt" : ""}` }));
  const tierEls = TIERS.map((t, i) => h("span", { class: `md-tier ${TIER_CLS[i]}` }, t));
  const tickEls = EDGES.map((v) => h("span", { class: "md-wpm" }, String(v)));
  const unitEl = h("span", { class: "md-wpm unit" }, "WPM");
  const lenAxis = h("div", { class: "md-len-axis" });
  guides.append(...bandEls, ...tierEls, ...tickEls, unitEl, lenAxis);
  function drawGuides() {
    const iw = W - PAD.l - PAD.r;
    TIERS.forEach((_, i) => {
      const x0 = PAD.l + bandsAt[i] * iw, bw = (bandsAt[i + 1] - bandsAt[i]) * iw;
      Object.assign(bandEls[i].style, { left: `${x0}px`, width: `${bw}px`, top: `${PAD.t - 10}px`, bottom: `${PAD.b - 8}px` });
      Object.assign(tierEls[i].style, { left: `${x0 + bw / 2}px`, top: `${H - PAD.b + 14}px` });
      tierEls[i].textContent = bw < 64 ? TIERS[i].slice(0, 3) : TIERS[i]; // narrow band: short label
      if (i > 0) Object.assign(tickEls[i - 1].style, { left: `${x0}px`, top: `${PAD.t - 18}px` });
    });
    Object.assign(unitEl.style, { left: `${PAD.l + iw + 2}px`, top: `${PAD.t - 18}px`, transform: "translateX(-100%)" });
    unitEl.style.display = (1 - bandsAt[4]) * iw < 70 ? "none" : ""; // no room next to the last tick
    const rows: Node[] = [h("span", { class: "md-len-cap" }, "length (1×)")];
    for (let d = dMin; d <= dMax; d += 60) {
      const y = yOf(d);
      const rule = h("div", { class: "md-rule" }); rule.style.top = `${y}px`; rule.style.left = `${PAD.l - 6}px`; rule.style.right = `${PAD.r}px`;
      const lab = h("span", { class: "md-len" }, fmtLen(d)); lab.style.top = `${y}px`;
      rows.push(rule, lab);
    }
    lenAxis.replaceChildren(...rows);
  }

  function setLines() {
    const t = targets();
    edges = [];
    for (let k = 0; k < 5; k++) {
      const idx = songs.map((_, i) => i).filter((i) => difficultyOf(songs[i], speed).tier === TIERS[k]);
      edges.push(...mst(idx, t));
    }
    lineEls = edges.map(() => document.createElementNS(SVG, "line"));
    svg.replaceChildren(...lineEls);
    return t;
  }

  function paint(p: Pt[]) {
    p.forEach((q, i) => { stars[i].style.transform = `translate(${q.x}px, ${q.y}px)`; });
    edges.forEach(([a, b], k) => {
      const l = lineEls[k];
      l.setAttribute("x1", p[a].x.toFixed(1)); l.setAttribute("y1", p[a].y.toFixed(1));
      l.setAttribute("x2", p[b].x.toFixed(1)); l.setAttribute("y2", p[b].y.toFixed(1));
    });
  }

  /** Lay the chart out for the current size and speed (tweening from where the stars are now). */
  function layout(animate: boolean) {
    W = chart.clientWidth; H = chart.clientHeight;
    if (!W || !H) return;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    bandsAt = bandEdges();
    guides.classList.toggle("md-moving", animate);
    drawGuides();
    const to = setLines();
    cancelAnimationFrame(raf);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) { shown = to; paint(to); return; }
    const from = shown.map((q) => ({ ...q })), t0 = performance.now();
    const step = (now: number) => {
      const k = ease(Math.min(1, (now - t0) / TWEEN_MS));
      shown = from.map((q, i) => ({ x: q.x + (to[i].x - q.x) * k, y: q.y + (to[i].y - q.y) * k }));
      paint(shown);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  function showTip(i: number) {
    const s = songs[i], d = difficultyOf(s, speed), cover = s.art ?? s.thumb;
    tip.replaceChildren(
      cover ? h("img", { class: "md-tip-art", src: cover, alt: "" }) : h("span", { class: "md-tip-art" }),
      h("div", { class: "md-tip-text" },
        h("b", {}, s.title), h("span", {}, s.artist),
        h("span", { class: "md-tip-meta" }, h("i", { class: d.cls }, d.tier), ` · ~${d.needs} WPM · ${lengthAt(s, speed)}`)));
    const q = shown[i];
    tip.classList.add("on");
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = q.x + 14, y = q.y - th / 2;
    if (x + tw > W - 6) x = q.x - 14 - tw;
    y = Math.max(6, Math.min(H - th - 6, y));
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }
  function hideTip() { tip.classList.remove("on"); }

  // ---------- list view ----------
  function renderList() {
    const m = hits();
    const rows = order().filter((i) => m[i]).map((i) => {
      const s = songs[i], d = difficultyOf(s, speed);
      const row = h("button", { class: `md-row${i === sel ? " on" : ""}`, role: "option", "aria-selected": i === sel ? "true" : "false", onclick: () => select(i), ondblclick: () => startSong(s, speed) },
        h("span", { class: `md-row-dot ${d.cls}`, "aria-hidden": "true" }),
        h("span", { class: "md-row-title" }, s.title),
        h("span", { class: "md-row-artist" }, s.artist),
        h("span", { class: "md-row-wpm" }, `${d.needs}`, h("small", {}, " wpm")),
        h("span", { class: "md-row-len" }, lengthAt(s, speed)));
      return row;
    });
    list.replaceChildren(...(rows.length ? rows : [h("p", { class: "md-empty" }, "No songs match.")]));
    list.querySelector(".md-row.on")?.scrollIntoView({ block: "nearest" });
  }

  // ---------- panel ----------
  function renderPanel() {
    const s = songs[sel];
    if (!s) { panel.replaceChildren(h("p", { class: "md-empty" }, "No songs.")); return; }
    const d = difficultyOf(s, speed), best = bestOf(s, speed), src = sourceFor(s), cover = s.art ?? s.thumb;
    panel.replaceChildren(
      h("div", { class: "md-cover" }, cover ? h("img", { src: cover, alt: `${s.title} cover` }) : ""),
      h("div", { class: "md-title" },
        h("h2", {}, s.title),
        h("p", {}, s.artist)),
      h("div", { class: "md-speeds", role: "radiogroup", "aria-label": "Speed" }, ...SPEEDS.map((v) =>
        h("button", { class: `md-speed${v === speed ? " on" : ""}`, role: "radio", "aria-checked": v === speed ? "true" : "false", onclick: () => setSpeed(v) }, `${v}×`))),
      h("dl", { class: "md-stats" },
        stat("Tier", h("span", { class: d.cls }, d.tier)),
        stat("Needs", `~${d.needs} WPM`),
        stat("Hardest line", `${d.burst} WPM`),
        stat("Length", lengthAt(s, speed)),
        stat("Lines", String(s.lines)),
        stat("Best", best ? `${best.grade} · ${pct(best.accuracy)}` : "—")),
      best ? h("p", { class: "md-best" }, `Best score ${fmtScore(best.score)}${best.fc ? " · every line clean" : ""}`) : "",
      h("button", { class: "hero-play md-play", disabled: !src, onclick: () => startSong(s, speed) },
        h("span", { class: "hero-play-icon", "aria-hidden": "true" }), "Play"),
      h("p", { class: "md-source" }, src === "youtube" ? "Plays from YouTube" : src === "local" ? "Plays from the local file" : "No audio available"),
      h("p", { class: "md-keys" }, h("kbd", {}, "↑↓"), " song ", h("kbd", {}, "←→"), " speed ", h("kbd", {}, "Enter"), " play"));
  }
  function stat(label: string, value: Node | string) {
    return h("div", { class: "md-stat" }, h("dt", {}, label), h("dd", {}, value));
  }

  // ---------- state ----------
  function paintState() {
    const m = hits(), n = m.filter(Boolean).length;
    stars.forEach((b, i) => {
      b.classList.toggle("dim", !!query && !m[i]);
      b.classList.toggle("hit", !!query && m[i]);
      b.classList.toggle("sel", i === sel);
      b.classList.toggle("best", !!bestOf(songs[i], speed));
      b.setAttribute("aria-selected", i === sel ? "true" : "false");
      b.tabIndex = i === sel ? 0 : -1;
    });
    svg.classList.toggle("dim", !!query);
    count.textContent = query ? `${n} of ${songs.length}` : `${songs.length} songs`;
    if (view === "list") renderList();
  }
  function select(i: number) {
    if (i < 0 || !songs[i]) return;
    sel = i;
    settings.levelId = songs[i].id; saveSettings();
    renderPanel(); paintState();
  }
  function setSpeed(v: number) {
    if (v === speed) return;
    speed = v; settings.speed = v; saveSettings();
    renderPanel(); paintState();
    layout(true);
  }
  function setView(v: "chart" | "list") {
    view = v;
    chartBtn.classList.toggle("on", v === "chart"); listBtn.classList.toggle("on", v === "list");
    chart.classList.toggle("hidden", v === "list"); list.classList.toggle("hidden", v === "chart");
    if (v === "chart") requestAnimationFrame(() => layout(false));
    paintState();
  }
  /** ↑/↓: previous/next song by difficulty (among search matches, if searching). */
  function step(dir: number) {
    const m = hits(), ord = order().filter((i) => m[i]);
    if (!ord.length) return;
    const at = ord.indexOf(sel);
    select(ord[at < 0 ? 0 : Math.max(0, Math.min(ord.length - 1, at + dir))]);
  }

  search.addEventListener("input", () => { query = search.value; paintState(); });

  const ro = new ResizeObserver(() => { if (view === "chart") layout(false); });
  ro.observe(chart);
  renderPanel(); paintState();
  requestAnimationFrame(() => layout(false));

  return {
    el,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const typing = document.activeElement === search;
      if (k === "Escape") {
        e.preventDefault();
        if (query) { search.value = ""; query = ""; paintState(); }
        else if (typing) search.blur();
        else navigate("mocks");
        return;
      }
      if (k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); step(k === "ArrowUp" ? -1 : 1); return; }
      if (k === "Enter") {
        e.preventDefault();
        if (typing) {
          const first = order().find((i) => hits()[i]);
          if (first !== undefined && query) select(first);
          search.blur();
        } else if (songs[sel] && !e.repeat) startSong(songs[sel], speed);
        return;
      }
      if (typing) return; // let the search field have the other keys
      if (k === "/") { e.preventDefault(); search.focus(); search.select(); }
      else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        const i = SPEEDS.indexOf(speed) + (k === "ArrowLeft" ? -1 : 1);
        setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i))]);
      } else if (k.toLowerCase() === "l") setView(view === "chart" ? "list" : "chart");
    },
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
