// Song menu mockup C, "Song wheel": the rhythm-game song select. A wheel of songs on the right (the
// selected one sits at the centre; the rest shrink, fade and curve away), the selected song large on the left.
import "./mock-c.css";
import { h, fmtScore, pct } from "../dom";
import { navigate, type Screen } from "../main";
import { navbar, sky } from "../landing";
import { settings, saveSettings } from "../settings";
import {
  loadSongs, difficultyOf, bestOf, lengthAt, sourceFor, startSong, matches, SPEEDS, type Song,
} from "./songs";

type Sort = "title" | "artist" | "difficulty";
const ROW = 66; // wheel spacing (px)
const GAP = 14; // extra space either side of the selected row

const coverOf = (s: Song) => s.art ?? s.thumb ?? "";
const byText = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

export async function mockCScreen(): Promise<Screen> {
  const all = await loadSongs();
  let speed = SPEEDS.includes(settings.speed) ? settings.speed : 1;
  let sort: Sort = "title";
  let query = "";
  let list: Song[] = [];
  // The wheel loops when there are enough songs: sel/pos are "virtual" indices (any integer), and
  // song(i) wraps them into the list. With few songs (a narrow search) it clamps at the ends instead.
  let sel = 0;
  let pos = 0; // animated wheel position (fractional virtual index)
  const loops = () => list.length > 16;
  const wrap = (i: number) => ((i % list.length) + list.length) % list.length;
  const current = () => (list.length ? list[wrap(sel)] : undefined);
  let raf = 0;

  // ---------- elements ----------
  const backdrop = h("div", { class: "mc-backdrop", "aria-hidden": "true" });
  const cover = h("img", { class: "mc-cover", alt: "" });
  const title = h("h1", { class: "mc-title" });
  const artist = h("p", { class: "mc-artist" });
  const tierEl = h("p", { class: "mc-tier" });
  const stats = h("dl", { class: "mc-stats" });
  const source = h("p", { class: "mc-source" });
  const speeds = h("div", { class: "mc-speeds", role: "radiogroup", "aria-label": "Speed" });
  const play = h("button", { class: "hero-play mc-play", onclick: () => playSel() },
    h("span", { class: "hero-play-icon", "aria-hidden": "true" }), "Play");

  const search = h("input", {
    class: "mc-search", type: "search", placeholder: "Search songs or artists", "aria-label": "Search songs",
    spellcheck: "false", autocomplete: "off",
  }) as HTMLInputElement;
  const count = h("span", { class: "mc-count" });
  const sorts = h("div", { class: "mc-sorts", role: "tablist", "aria-label": "Sort by" });
  const rows = h("div", { class: "mc-rows" });
  const empty = h("p", { class: "mc-empty hidden" }, "No songs match.");
  const wheel = h("div", { class: "mc-wheel", tabindex: "-1" }, rows, empty);

  const el = h("div", { class: "landing mc-page" },
    backdrop, sky(), navbar(),
    h("main", { class: "mc-main" },
      h("section", { class: "mc-detail", "aria-live": "polite" },
        h("div", { class: "mc-hero" },
          h("div", { class: "mc-cover-wrap" }, cover),
          h("div", { class: "mc-heading" }, tierEl, title, artist)),
        stats,
        h("div", { class: "mc-controls" }, speeds, play),
        source),
      h("section", { class: "mc-list" },
        h("div", { class: "mc-tools" },
          h("label", { class: "mc-search-wrap" }, search, h("kbd", {}, "/")),
          h("div", { class: "mc-tools-row" }, sorts, count)),
        wheel,
        h("p", { class: "mc-keys" },
          h("span", {}, h("kbd", {}, "↑↓"), " song"), h("span", {}, h("kbd", {}, "←→"), " speed"),
          h("span", {}, h("kbd", {}, "Enter"), " play"), h("span", {}, h("kbd", {}, "Esc"), " back")))));

  // ---------- list ----------
  function sorted(songs: Song[]): Song[] {
    const out = [...songs];
    if (sort === "title") out.sort((a, b) => byText(a.title, b.title) || byText(a.artist, b.artist));
    else if (sort === "artist") out.sort((a, b) => byText(a.artist, b.artist) || byText(a.title, b.title));
    else out.sort((a, b) => difficultyOf(a, speed).needs - difficultyOf(b, speed).needs || byText(a.title, b.title));
    return out;
  }
  function rebuild(keepId = current()?.id) {
    list = sorted(all.filter((s) => matches(s, query)));
    const i = list.findIndex((s) => s.id === keepId);
    sel = i >= 0 ? i : 0;
    pos = sel; // jump, don't spin through the whole list
    rowEls.forEach((r) => r.remove());
    rowEls.clear();
    count.textContent = query ? `${list.length} of ${all.length}` : `${all.length} songs`;
    empty.classList.toggle("hidden", list.length > 0);
    renderSorts();
    renderDetail();
    place();
  }

  // ---------- wheel ----------
  const rowEls = new Map<number, HTMLElement>(); // by virtual index
  function rowFor(i: number): HTMLElement {
    let r = rowEls.get(i);
    if (r) return r;
    const s = list[wrap(i)];
    const d = difficultyOf(s, speed);
    const best = bestOf(s, speed);
    r = h("button", { class: "mc-row", tabindex: "-1", onclick: () => select(i), ondblclick: () => playSel() },
      h("img", { class: "mc-row-art", src: coverOf(s), alt: "", loading: "lazy" }),
      h("span", { class: "mc-row-text" }, h("span", { class: "mc-row-title" }, s.title), h("span", { class: "mc-row-artist" }, s.artist)),
      best ? h("span", { class: `mc-row-grade g-${best.grade}` }, best.grade) : null,
      h("span", { class: `mc-row-tier ${d.cls}`, title: `${d.tier} · ~${d.needs} WPM` }, h("i", {}), String(d.needs)));
    rowEls.set(i, r);
    rows.append(r);
    return r;
  }
  function place() {
    const H = wheel.clientHeight;
    const reach = Math.ceil(H / 2 / ROW) + 2;
    let lo = Math.floor(pos) - reach, hi = Math.ceil(pos) + reach;
    if (!loops()) { lo = Math.max(0, lo); hi = Math.min(list.length - 1, hi); }
    if (!list.length) hi = lo - 1;
    const keep = new Set<number>();
    for (let i = lo; i <= hi; i++) {
      const r = rowFor(i);
      keep.add(i);
      const d = i - pos, a = Math.abs(d);
      const y = H / 2 + d * ROW + Math.sign(d) * Math.min(a, 1) * GAP;
      const x = Math.min(a * a * 7, 90); // rows curve away like the rim of a wheel
      const scale = 1 - Math.min(a, 5) * 0.05;
      r.style.transform = `translate(${x}px, ${y - ROW / 2}px) scale(${scale})`;
      r.style.opacity = String(Math.max(0, 1 - a * 0.17));
      r.style.zIndex = String(100 - Math.round(a * 10));
      r.classList.toggle("mc-sel", i === sel);
    }
    rowEls.forEach((r, i) => { if (!keep.has(i)) { r.remove(); rowEls.delete(i); } });
  }
  function animate() {
    cancelAnimationFrame(raf);
    const step = () => {
      pos += (sel - pos) * 0.2;
      if (Math.abs(sel - pos) < 0.002) pos = sel;
      place();
      if (pos !== sel) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function select(i: number) {
    if (!list.length) return;
    const n = loops() ? i : Math.max(0, Math.min(list.length - 1, i));
    if (n === sel) return;
    sel = n;
    if (Math.abs(sel - pos) > 10) pos = sel - Math.sign(sel - pos) * 3; // long jumps: a short spin, not a blur
    renderDetail();
    animate();
  }
  /** Select a song by its index in the list (shortest way round when looping). */
  function selectIndex(j: number) {
    if (!loops()) return select(j);
    let d = j - wrap(sel);
    if (d > list.length / 2) d -= list.length;
    if (d < -list.length / 2) d += list.length;
    select(sel + d);
  }

  // ---------- selected song ----------
  function renderSorts() {
    sorts.replaceChildren(...(["title", "artist", "difficulty"] as Sort[]).map((k) =>
      h("button", { class: "mc-sort" + (k === sort ? " on" : ""), role: "tab", "aria-selected": String(k === sort),
        onclick: () => { sort = k; rebuild(); } }, k[0].toUpperCase() + k.slice(1))));
  }
  function stat(label: string, value: Node | string) {
    return h("div", { class: "mc-stat" }, h("dt", {}, label), h("dd", {}, value));
  }
  function renderDetail() {
    const s = current();
    el.classList.toggle("mc-none", !s);
    if (!s) return;
    const d = difficultyOf(s, speed);
    const best = bestOf(s, speed);
    const art = coverOf(s);
    if (cover.getAttribute("src") !== art) {
      cover.src = art;
      backdrop.style.backgroundImage = art ? `url("${art}")` : "none";
    }
    cover.classList.toggle("mc-wide", !s.art); // a video frame, not a square cover
    title.textContent = s.title;
    artist.textContent = s.artist;
    tierEl.className = `mc-tier ${d.cls}`;
    tierEl.replaceChildren(h("i", {}), d.tier, h("span", {}, ` · needs ~${d.needs} WPM`));
    stats.replaceChildren(
      stat("Hardest line", `${d.burst} WPM`),
      stat("Length", lengthAt(s, speed)),
      stat("Lines", String(s.lines)),
      stat("Best", best ? h("span", {}, h("b", { class: `g-${best.grade}` }, best.grade), ` ${fmtScore(best.score)} · ${pct(best.accuracy)}`) : "—"));
    const src = sourceFor(s);
    source.textContent = src === "local" ? "Audio: local file" : src === "youtube" ? "Audio: YouTube" : "No audio available";
    play.toggleAttribute("disabled", !src);
    speeds.replaceChildren(...SPEEDS.map((v) =>
      h("button", { class: "mc-speed" + (v === speed ? " on" : ""), role: "radio", "aria-checked": String(v === speed),
        onclick: () => setSpeed(v) }, `${v}×`)));
  }
  function setSpeed(v: number) {
    if (v === speed) return;
    speed = v;
    settings.speed = v;
    saveSettings();
    rowEls.forEach((r) => r.remove()); // tiers depend on the speed
    rowEls.clear();
    if (sort === "difficulty") rebuild(); else { renderDetail(); place(); }
  }
  function playSel() {
    const s = current();
    if (s && sourceFor(s)) startSong(s, speed);
  }

  // ---------- input ----------
  let wheelAcc = 0;
  wheel.addEventListener("wheel", (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    const steps = Math.trunc(wheelAcc / 60);
    if (steps) { wheelAcc -= steps * 60; select(sel + steps); }
  }, { passive: false });
  search.addEventListener("input", () => { query = search.value; rebuild(); });

  let typed = "", typedAt = 0;
  function jumpTo(ch: string) {
    // typing letters jumps to the next title (or artist, when sorted by artist) starting with them
    const now = performance.now();
    typed = now - typedAt < 800 ? typed + ch : ch;
    typedAt = now;
    const key = (s: Song) => (sort === "artist" ? s.artist : s.title).toLowerCase();
    const here = wrap(sel);
    const start = typed.length > 1 ? here : here + 1;
    for (let k = 0; k < list.length; k++) {
      const i = (start + k) % list.length;
      if (key(list[i]).startsWith(typed)) { selectIndex(i); return; }
    }
  }

  const onResize = () => place();
  window.addEventListener("resize", onResize);

  const initial = all.find((s) => s.id === settings.levelId)?.id;
  rebuild(initial);
  requestAnimationFrame(place); // after layout, when the wheel has a height

  return {
    el,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      const inSearch = e.target === search;
      if (k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); select(sel + (k === "ArrowUp" ? -1 : 1)); return; }
      if (k === "PageUp" || k === "PageDown") { e.preventDefault(); select(sel + (k === "PageUp" ? -8 : 8)); return; }
      if (k === "Enter") { e.preventDefault(); if (!e.repeat) playSel(); return; }
      if (k === "Escape") {
        e.preventDefault();
        if (query) { search.value = ""; query = ""; rebuild(); search.blur(); }
        else if (inSearch) search.blur();
        else navigate("mocks");
        return;
      }
      if (inSearch) return; // typing goes to the search field
      if (k === "Home" || k === "End") { e.preventDefault(); selectIndex(k === "Home" ? 0 : list.length - 1); return; }
      if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        const i = SPEEDS.indexOf(speed) + (k === "ArrowLeft" ? -1 : 1);
        setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i))]);
        return;
      }
      if (k === "/") { e.preventDefault(); search.focus(); search.select(); return; }
      if (/^[a-z0-9]$/i.test(k)) { e.preventDefault(); jumpTo(k.toLowerCase()); }
    },
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    },
  };
}
